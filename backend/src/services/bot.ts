import { prisma } from '../lib/prisma.js';
import { decrypt } from '../lib/crypto.js';
import { BitsoClient } from './bitso.js';
import { generateSignal } from './ai.js';
import { setState, logEvent } from '../lib/activity.js';
import { valuePortfolio } from '../lib/portfolio.js';
import { getRegime } from './regime.js';
import { fixedFractionalSize } from '../lib/sizing.js';
import { getBookLimits, BookLimits } from '../lib/bookLimits.js';

// Pares y umbrales por perfil de estrategia.
const SYMBOLS: Record<string, string[]> = {
  conservative: ['btc_mxn', 'eth_mxn'],
  balanced: ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn'],
  aggressive: ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn', 'ltc_mxn', 'trx_mxn', 'mana_mxn'],
};
const MIN_CONF: Record<string, number> = { conservative: 0.7, balanced: 0.6, aggressive: 0.5 };
const DEFAULT_ORDER_MXN = 200;
const PLAN_TTL_H = 8; // validez de cada instrucción

/** Cancela instrucciones pendientes previas del mismo par (evita duplicados). */
async function clearPending(userId: string, symbol: string): Promise<void> {
  await prisma.instruction.updateMany({
    where: { userId, symbol, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
}

/**
 * ROTACIÓN: vende una posición en hold para fondear una oportunidad de compra.
 * Prioriza vender la de mayor ganancia (o la más pequeña) que no sea la del par objetivo.
 */
async function tryRotate(userId: string, excludeSymbol: string, client: BitsoClient): Promise<number> {
  const positions = await prisma.position.findMany({ where: { userId, baseAmount: { gt: 0 } } });
  const others = positions.filter((p) => p.symbol !== excludeSymbol);
  if (!others.length) return 0;

  let best: { symbol: string; qty: number; price: number; value: number; pnlPct: number; score: number } | null = null;
  for (const p of others) {
    try {
      const t = await client.ticker(p.symbol);
      const price = Number(t.last ?? 0);
      const qty = Number(p.baseAmount);
      const value = qty * price;
      if (value <= 0) continue;
      const avg = Number(p.avgCostMxn);
      const pnlPct = avg > 0 ? ((price - avg) / avg) * 100 : 0;
      const score = pnlPct + (value >= 20 ? 10 : 0);
      if (!best || score > best.score) best = { symbol: p.symbol, qty, price, value, pnlPct, score };
    } catch {}
  }
  if (!best) return 0;

  await prisma.instruction.create({
    data: {
      userId, symbol: best.symbol, side: 'SELL', trigger: 'immediate', triggerPrice: String(best.price),
      quantity: String(best.qty), reason: `Rotar → ${excludeSymbol}`, status: 'PENDING',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  });
  await logEvent(
    userId,
    `🔄 Rotando: vendo ${best.symbol} (${best.pnlPct >= 0 ? '+' : ''}${best.pnlPct.toFixed(1)}%) para comprar ${excludeSymbol}`,
    'warn',
  );
  return best.value;
}

/**
 * Lista de pares a operar:
 *  - "auto"        → todos los pares contra MXN que ofrece Bitso
 *  - "a,b,c"       → lista personalizada
 *  - vacío         → según el perfil
 */
async function resolveSymbols(
  custom: string | null,
  profile: string,
  client: BitsoClient,
  heldCurrencies: string[],
): Promise<string[]> {
  const c = (custom ?? '').trim().toLowerCase();

  let books: string[] = [];
  try {
    const b = await client.availableBooks();
    books = b.map((x: any) => String(x.book ?? ''));
  } catch {}
  const mxnBooks = books.filter((bk) => bk.endsWith('_mxn'));
  const validSet = new Set(books);

  let base: string[];
  if (c === 'auto') {
    base = mxnBooks.length ? mxnBooks : SYMBOLS[profile] ?? SYMBOLS.balanced;
  } else if (c) {
    base = c.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    base = SYMBOLS[profile] ?? SYMBOLS.balanced;
  }

  // Incluye las monedas que el usuario posee (solo si tienen par válido en MXN).
  const set = new Set(base);
  for (const cur of heldCurrencies) {
    if (!cur || cur === 'mxn') continue;
    const cand = `${cur}_mxn`;
    if (!books.length || validSet.has(cand)) set.add(cand);
  }
  return [...set];
}

/**
 * PLANIFICADOR (usa IA): analiza y deja INSTRUCCIONES con niveles y tiempo.
 * No coloca órdenes — de eso se encarga el ejecutor "tonto".
 */
export async function runBotForUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.bitsoApiKey || !user.bitsoApiSecret || !user.tradingEnabled) return;

  const client = new BitsoClient({
    apiKey: decrypt(user.bitsoApiKey),
    apiSecret: decrypt(user.bitsoApiSecret),
  });

  const limits = await getBookLimits(client).catch(() => new Map<string, BookLimits>());

  await setState(userId, 'reading_balance', 'Leyendo saldo de Bitso');
  await logEvent(userId, 'IA planificando · leyendo saldo', 'info');

  let balances: any[];
  try {
    balances = await client.balance();
  } catch (err) {
    await logEvent(userId, `Error Bitso: ${(err as Error).message}`, 'error');
    await setState(userId, 'error', 'Error de conexión Bitso');
    throw err;
  }
  await logEvent(userId, `Saldo leído · ${balances.length} monedas`, 'info');

  const prevMxnSnap = await prisma.balanceSnapshot.findFirst({
    where: { userId, currency: 'mxn' },
    orderBy: { capturedAt: 'desc' },
  });

  for (const b of balances) {
    await prisma.balanceSnapshot.create({
      data: {
        userId,
        currency: String(b.currency ?? '').toLowerCase(),
        available: String(b.available ?? '0'),
        locked: String(b.locked ?? '0'),
        total: String(b.total ?? '0'),
      },
    });
  }

  let equityMxn = 0;
  try {
    const val = await valuePortfolio(client, balances);
    equityMxn = val.totalMxn;
    await prisma.portfolioSnapshot.create({
      data: { userId, totalMxn: String(val.totalMxn), holdings: val.holdings as any },
    });
    await logEvent(userId, `Portafolio valuado · $${val.totalMxn.toFixed(2)} MXN`, 'ok');
  } catch (err) {
    await logEvent(userId, `Error valuando portafolio: ${(err as Error).message.slice(0, 60)}`, 'warn');
  }

  const mxn = balances.find((b) => String(b.currency).toLowerCase() === 'mxn');
  const mxnAvailable = Number(mxn?.available ?? '0');

  // Detección de depósitos/retiros por transferencia (por diferencia de saldo MXN,
  // descontando las operaciones del propio bot) → NO se cuentan como ganancia.
  if (prevMxnSnap) {
    try {
      const tradesSince = await prisma.trade.findMany({
        where: { userId, createdAt: { gt: prevMxnSnap.capturedAt } },
      });
      const netTradeMxn = tradesSince.reduce(
        (s, t) => s + (t.side === 'SELL' ? Number(t.amount) * Number(t.price) : -Number(t.amount)),
        0,
      );
      const delta = mxnAvailable - Number(prevMxnSnap.available);
      const net = delta - netTradeMxn;
      if (net > 5) {
        await prisma.deposit.create({
          data: { userId, currency: 'mxn', amount: String(Math.round(net * 100) / 100), kind: 'DEPOSIT', note: 'transferencia detectada' },
        });
        await logEvent(userId, `💰 Depósito detectado: $${net.toFixed(2)} MXN (no cuenta como ganancia)`, 'ok');
      } else if (net < -5) {
        await prisma.deposit.create({
          data: { userId, currency: 'mxn', amount: String(Math.round(-net * 100) / 100), kind: 'WITHDRAWAL', note: 'retiro detectado' },
        });
        await logEvent(userId, `📤 Retiro detectado: $${(-net).toFixed(2)} MXN`, 'warn');
      }
    } catch {}
  }

  const maxOrder = user.maxOrderAmount ? Number(user.maxOrderAmount) : DEFAULT_ORDER_MXN;
  const riskPct = user.riskPct ? Number(user.riskPct) : 1;
  const cashReservePct = user.cashReservePct != null ? Number(user.cashReservePct) : 30;
  const stopLossPct = user.stopLossPct ? Number(user.stopLossPct) : 0;

  const profile = user.profile ?? 'balanced';
  const minConf = MIN_CONF[profile] ?? 0.6;
  const rotate = user.rotate !== false;
  const volatileTop = user.volatileTop ?? 3;
  const dcaLevels = user.dcaLevels ? Math.max(1, Math.min(10, user.dcaLevels)) : 3;
  const dcaStepPct = user.dcaStepPct ? Number(user.dcaStepPct) : 2;
  const heldCurrencies = balances
    .filter((b: any) => String(b.currency).toLowerCase() !== 'mxn' && Number(b.total ?? 0) > 0)
    .map((b: any) => String(b.currency).toLowerCase());
  const symbols = await resolveSymbols(user.symbols, profile, client, heldCurrencies);

  const botSetting = await prisma.setting.findUnique({ where: { key: 'bot' } });
  const regimeFilter = (botSetting?.value as any)?.regimeFilter !== false;
  let regime: Awaited<ReturnType<typeof getRegime>> | null = null;
  try {
    regime = await getRegime();
  } catch {}
  if (regime) {
    await logEvent(userId, `Régimen: ${regime.zone} (${regime.score}/100)`, regime.zone === 'RISK_OFF' ? 'warn' : 'info');
  }

  // Efectivo disponible que se irá repartiendo entre los pares (no sobre-comprometer)
  let cashRemaining = Math.max(0, mxnAvailable - equityMxn * (cashReservePct / 100));

  // ⚡ Selección VOLÁTIL: mide el movimiento (ticker) y se queda con las N más volátiles.
  const tickerCache = new Map<string, any>();
  const ranked: Array<{ symbol: string; vol: number }> = [];
  for (const sym of symbols) {
    try {
      const t = await client.ticker(sym);
      tickerCache.set(sym, t);
      const last = Number(t.last ?? 0);
      const high = Number(t.high ?? 0);
      const low = Number(t.low ?? 0);
      const vol = last > 0 ? ((high - low) / last) * 100 : 0;
      ranked.push({ symbol: sym, vol });
    } catch {}
  }
  ranked.sort((a, b) => b.vol - a.vol);
  const selected = (volatileTop > 0 ? ranked.slice(0, volatileTop) : ranked).map((r) => r.symbol);
  if (selected.length) {
    await logEvent(
      userId,
      `⚡ Top volátiles: ${selected.map((s) => `${s.split('_')[0].toUpperCase()} ${(ranked.find((r) => r.symbol === s)?.vol ?? 0).toFixed(1)}%`).join(' · ')}`,
      'info',
    );
  }

  for (const symbol of selected) {
    try {
      const ticker = tickerCache.get(symbol) ?? (await client.ticker(symbol));
      const last = Number(ticker.last ?? 0);
      const base = symbol.split('_')[0];
      const bal = balances.find((b) => String(b.currency).toLowerCase() === base);
      const baseAvailable = Number(bal?.available ?? '0');
      const key = { userId_symbol: { userId, symbol } };
      let pos = await prisma.position.findUnique({ where: key });
      if (!pos && baseAvailable > 0) {
        const buys = await prisma.trade.findMany({ where: { userId, symbol, side: 'BUY' } });
        if (buys.length) {
          let q = 0;
          let c = 0;
          for (const t of buys) {
            const p = Number(t.price);
            const m = Number(t.amount);
            const qty = p > 0 ? m / p : 0;
            q += qty;
            c += qty * p;
          }
          if (q > 0) {
            pos = await prisma.position.upsert({
              where: key,
              update: {},
              create: { userId, symbol, baseAmount: String(Math.min(baseAvailable, q)), avgCostMxn: String(c / q) },
            });
          }
        }
      }
      const posQty = pos ? Number(pos.baseAmount) : 0;
      const avg = pos ? Number(pos.avgCostMxn) : 0;

      await setState(userId, 'ai_thinking', 'IA analizando mercado', symbol);
      await logEvent(userId, `IA analizando ${symbol}`, 'ai');

      const recentSignals = await prisma.signal.findMany({
        where: { userId, symbol },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });

      const ctx = {
        symbol,
        ticker: {
          last: String(ticker.last ?? ''),
          bid: String(ticker.bid ?? ''),
          ask: String(ticker.ask ?? ''),
          high: String(ticker.high ?? ''),
          low: String(ticker.low ?? ''),
          volume: String(ticker.volume ?? ''),
        },
        balances: balances.map((b: any) => ({
          currency: String(b.currency).toLowerCase(),
          available: String(b.available ?? '0'),
          total: String(b.total ?? '0'),
        })),
        recentSignals: recentSignals.map((s) => ({ action: s.action, confidence: String(s.confidence ?? '0') })),
        position: { currency: base, amount: baseAvailable, avgCostMxn: avg > 0 ? avg : null },
        aggressive: profile === 'aggressive',
      };

      const signal = await generateSignal(symbol, ctx);
      await prisma.signal.create({
        data: {
          userId, symbol, action: signal.action, confidence: signal.confidence, reasoning: signal.reasoning,
          tokensUsed: signal.tokensUsed, latencyMs: signal.latencyMs, executed: false,
        },
      });
      await logEvent(userId, `${symbol} → ${signal.action} (${(signal.confidence * 100).toFixed(0)}%)`, signal.action === 'HOLD' ? 'info' : 'ok');

      if (!user.autoTrade || signal.action === 'HOLD' || signal.confidence < minConf) continue;

      // Si ya hay un plan activo para este par, se conserva (no re-crear la escalera).
      const pendingCount = await prisma.instruction.count({ where: { userId, symbol, status: 'PENDING' } });
      if (pendingCount > 0) {
        await logEvent(userId, `Plan ${symbol} ya activo, se conserva`, 'info');
        continue;
      }

      if (signal.action === 'BUY') {
        if (regimeFilter && regime && regime.zone === 'RISK_OFF') {
          await logEvent(userId, `Compra bloqueada por régimen RISK_OFF · ${symbol}`, 'warn');
          continue;
        }
        let size = stopLossPct > 0 ? fixedFractionalSize(equityMxn, riskPct, stopLossPct) : maxOrder;
        if (!isFinite(size) || size <= 0) size = maxOrder;
        let spend = Math.min(maxOrder, size, cashRemaining);
        const entry = signal.entryPrice && signal.entryPrice > 0 ? signal.entryPrice : last;

        // Respetar mínimos de Bitso (monto y valor por orden) antes de crear el plan
        const lim = limits.get(symbol);
        const minValue = lim?.minimumValue ?? 0;
        const minAmount = lim?.minimumAmount ?? 0;
        const minPerTranche = Math.max(minValue, minAmount * entry);

        // Si no alcanza el efectivo, ROTA: vende una posición en hold para fondear esta oportunidad.
        if (spend < Math.max(1, minPerTranche) && rotate) {
          const freedValue = await tryRotate(userId, symbol, client);
          if (freedValue > 0) spend = Math.min(maxOrder, freedValue);
        }
        if (spend < Math.max(1, minPerTranche)) {
          await logEvent(userId, `Sin efectivo ni posiciones para rotar · ${symbol}`, 'warn');
          continue;
        }
        let levels = dcaLevels;
        if (minPerTranche > 0) levels = Math.max(1, Math.min(dcaLevels, Math.floor(spend / minPerTranche)));
        cashRemaining = Math.max(0, cashRemaining - spend);
        const per = spend / levels;
        const expires = new Date(Date.now() + PLAN_TTL_H * 3600 * 1000);
        for (let i = 0; i < levels; i++) {
          const price = entry * (1 - (i * dcaStepPct) / 100);
          await prisma.instruction.create({
            data: {
              userId, symbol, side: 'BUY', trigger: 'price_below', triggerPrice: String(price),
              amountMxn: String(per), reason: `${signal.reasoning} (DCA ${i + 1}/${levels})`, status: 'PENDING', expiresAt: expires,
            },
          });
        }
        await logEvent(
          userId,
          `📋 Plan DCA: BUY ${symbol} ×${levels} desde ${entry.toFixed(2)} (−${dcaStepPct}% c/nivel · $${per.toFixed(0)} c/u)`,
          'ok',
        );
      } else {
        const qty = Math.min(posQty > 0 ? posQty : baseAvailable, baseAvailable);
        const limS = limits.get(symbol);
        const belowMinS = limS && (qty < limS.minimumAmount || qty * last < limS.minimumValue);
        if (qty <= 0 || belowMinS) {
          await logEvent(userId, `Venta de ${symbol} no cumple el mínimo de Bitso · se omite`, 'warn');
          continue;
        }
        const target = signal.takeProfitPrice && signal.takeProfitPrice > 0 ? signal.takeProfitPrice : last;
        const trigger = target > last * 1.001 ? 'price_above' : 'immediate';
        await prisma.instruction.create({
          data: {
            userId, symbol, side: 'SELL', trigger, triggerPrice: String(trigger === 'price_above' ? target : last),
            quantity: String(qty), reason: signal.reasoning, status: 'PENDING',
            expiresAt: new Date(Date.now() + PLAN_TTL_H * 3600 * 1000),
          },
        });
        await logEvent(
          userId,
          `📋 Plan: SELL ${symbol} ${trigger === 'price_above' ? `si precio ≥ ${target.toFixed(2)}` : 'ya'}`,
          'ok',
        );
      }
    } catch (err) {
      await logEvent(userId, `Error ${symbol}: ${(err as Error).message.slice(0, 80)}`, 'error');
      console.error(`[planner] ${symbol} error usuario ${userId}:`, (err as Error).message);
    }
  }

  await setState(userId, 'idle', 'En espera');
  await logEvent(userId, 'Pasada completada', 'info');
}
