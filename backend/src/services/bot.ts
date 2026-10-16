import { prisma } from '../lib/prisma.js';
import { kv } from '../lib/kv.js';
import { generateSignal } from './ai.js';
import { makeExchangeClient, hasExchangeCreds, type ExchangeClient } from '../lib/exchange.js';
import { setState, logEvent } from '../lib/activity.js';
import { valuePortfolio } from '../lib/portfolio.js';
import { getRegime } from './regime.js';
import { fixedFractionalSize } from '../lib/sizing.js';
import { getBookLimits, BookLimits } from '../lib/bookLimits.js';
import { getIndicators } from '../lib/indicators.js';

// Pares y umbrales por perfil de estrategia.
const SYMBOLS: Record<string, string[]> = {
  conservative: ['btc_mxn', 'eth_mxn'],
  balanced: ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn'],
  aggressive: ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn', 'ltc_mxn', 'trx_mxn', 'mana_mxn'],
};
const MIN_CONF: Record<string, number> = { conservative: 0.7, balanced: 0.6, aggressive: 0.45 };
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
async function tryRotate(userId: string, excludeSymbol: string, client: ExchangeClient): Promise<number> {
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
 *  - "auto"        → todos los pares disponibles
 *  - "a,b,c"       → lista personalizada
 *  - vacío         → según el perfil
 */
async function resolveSymbols(
  custom: string | null,
  profile: string,
  client: ExchangeClient,
  heldCurrencies: string[],
  quote = 'mxn',
): Promise<string[]> {
  const c = (custom ?? '').trim().toLowerCase();

  let books: string[] = [];
  try {
    const b = await client.availableBooks();
    books = b.map((x: any) => String(x.book ?? ''));
  } catch {}
  const qBooks = books.filter((bk) => bk.endsWith(`_${quote}`));
  const validSet = new Set(books);
  const def = (SYMBOLS[profile] ?? SYMBOLS.balanced)
    .map((s) => s.replace('_mxn', `_${quote}`))
    .filter((s) => !s.startsWith(`${quote}_`));

  let base: string[];
  if (c === 'auto') {
    // 'auto' usa TODOS los pares, pero si son demasiados (Binance tiene cientos)
    // usamos la lista del perfil para no saturar la API.
    base = qBooks.length && qBooks.length <= 60 ? qBooks : def;
  } else if (c) {
    base = c.split(',').map((s) => s.trim()).filter(Boolean);
    // Solo pares válidos contra la moneda de cotización (MXN o USDT).
    if (books.length) base = base.filter((bk) => validSet.has(bk) && bk.endsWith(`_${quote}`));
  } else {
    base = def;
  }

  // Incluye las monedas que el usuario posee (solo si tienen par válido en la cotización).
  const set = new Set(base);
  for (const cur of heldCurrencies) {
    if (!cur || cur === quote) continue;
    const cand = `${cur}_${quote}`;
    if (!books.length || validSet.has(cand)) set.add(cand);
  }
  return [...set];
}

/**
 * Detecta RETIROS reales desde la API de Binance (el endpoint de depósitos da 404).
 * Devuelve cuánto se retiró (nuevo) para poder reiniciar la bóveda automáticamente.
 */
async function syncBitsoMovements(userId: string, client: ExchangeClient): Promise<{ withdrawn: number }> {
  let withdrawn = 0;
  // Depósitos: se suman como INVERSIÓN (nunca como ganancia).
  try {
    const deps = await (client as any).deposits?.();
    for (const d of deps ?? []) {
      try {
        const wid = String(d?.wid ?? '');
        if (!wid) continue;
        const status = String(d?.status ?? '').toLowerCase();
        if (status && !/complete|success|1/.test(status)) continue;
        const createdMs = new Date(d?.created_at ?? 0).getTime();
        if (!(createdMs > Date.now() - 365 * 864e5)) continue;
        const note = `binance-dep:${wid}`;
        if (await prisma.deposit.findFirst({ where: { userId, note } })) continue;
        const currency = String(d?.currency ?? '').toLowerCase();
        let mxn = Number(d?.amount ?? 0);
        if (!(mxn > 0)) continue;
        if (currency !== 'mxn') {
          const t = await client.ticker(`${currency}_mxn`);
          const p = Number(t.last ?? 0);
          if (!(p > 0)) continue;
          mxn = mxn * p;
        }
        await prisma.deposit.create({ data: { userId, currency, amount: String(mxn), kind: 'DEPOSIT', note } });
        await logEvent(userId, `⬇ Depósito (inversión): ${Number(d.amount).toFixed(2)} ${currency.toUpperCase()} (~$${mxn.toFixed(2)} MXN)`, 'ok');
      } catch {}
    }
  } catch {}
  try {
    const wds = await client.withdrawals();
    for (const w of wds) {
      try {
        const wid = String(w?.wid ?? w?.id ?? '');
        if (!wid) continue;
        const status = String(w?.status ?? '').toLowerCase();
        if (status && !/complete|confirm|done|sent|processing|pending/.test(status)) continue;
        const createdMs = new Date(w?.created_at ?? 0).getTime();
        if (!(createdMs > Date.now() - 45 * 864e5)) continue; // ignora retiros viejos (histórico)
        const note = `binance-wd:${wid}`;
        if (await prisma.deposit.findFirst({ where: { userId, note } })) continue;
        const currency = String(w?.currency ?? 'mxn').toLowerCase();
        let mxn = Number(w?.amount ?? 0);
        if (!(mxn > 0)) continue;
        if (currency !== 'mxn') {
          const t = await client.ticker(`${currency}_mxn`);
          const p = Number(t.last ?? 0);
          if (!(p > 0)) continue;
          mxn = mxn * p;
        }
        await prisma.deposit.create({ data: { userId, currency, amount: String(mxn), kind: 'WITHDRAWAL', note } });
        withdrawn += mxn;
        await logEvent(
          userId,
          `⬆ Retiro detectado (automático): ${Number(w.amount).toFixed(2)} ${currency.toUpperCase()} (~$${mxn.toFixed(2)} MXN)`,
          'ok',
        );
      } catch {}
    }
  } catch (err) {
    await logEvent(userId, `No se pudieron leer retiros de Binance: ${(err as Error).message.slice(0, 50)}`, 'warn');
  }
  return { withdrawn };
}

/**
 * PLANIFICADOR (usa IA): analiza y deja INSTRUCCIONES con niveles y tiempo.
 * No coloca órdenes — de eso se encarga el ejecutor "tonto".
 */
export async function runBotForUser(userId: string): Promise<void> {
  // Exclusión mutua por usuario: evita que dos pasadas (programada + inmediata)
  // planifiquen sobre el mismo saldo a la vez y dupliquen planes/órdenes.
  const lockKey = `bot:lock:${userId}`;
  if (await kv.get(lockKey)) {
    console.log(`[planner] ${userId} ya está en ejecución; se omite`);
    return;
  }
  await kv.set(lockKey, String(Date.now()), 180);
  try {
    await planForUser(userId);
  } finally {
    await kv.del(lockKey);
  }
}

async function planForUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.tradingEnabled || !hasExchangeCreds(user)) return;

  const client = await makeExchangeClient(user);
  if (!client) {
    await logEvent(userId, 'Faltan credenciales del exchange configurado', 'warn');
    return;
  }
  const exch = 'binance';
  const quote = (user.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';

  const limits = await getBookLimits(client, exch).catch(() => new Map<string, BookLimits>());

  await setState(userId, 'reading_balance', 'Leyendo saldo');
  await logEvent(userId, 'IA planificando · leyendo saldo', 'info');

  let balances: any[];
  try {
    balances = await client.balance();
  } catch (err) {
    await logEvent(userId, `Error de conexión: ${(err as Error).message}`, 'error');
    await setState(userId, 'error', 'Error de conexión');
    throw err;
  }
  await logEvent(userId, `Saldo leído · ${balances.length} monedas`, 'info');

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

  const cashBal = balances.find((b) => String(b.currency).toLowerCase() === quote);
  const cashAvailable = Number(cashBal?.available ?? '0');

  // Movimientos reales del exchange (retiros) → NO cuentan como ganancia y reinician la bóveda.
  const movements = await syncBitsoMovements(userId, client);

  const maxOrder = user.maxOrderAmount ? Number(user.maxOrderAmount) : DEFAULT_ORDER_MXN;
  const riskPct = user.riskPct ? Number(user.riskPct) : 1;
  const cashReservePct = user.cashReservePct != null ? Number(user.cashReservePct) : 30;
  const stopLossPct = user.stopLossPct ? Number(user.stopLossPct) : 0;
  const takeProfitPct = user.takeProfitPct ? Number(user.takeProfitPct) : 0;

  const profile = user.profile ?? 'balanced';
  const minConf = MIN_CONF[profile] ?? 0.6;
  const rotate = user.rotate !== false;
  const volatileTop = user.volatileTop ?? 3;
  const dcaLevels = user.dcaLevels ? Math.max(1, Math.min(10, user.dcaLevels)) : 3;
  const dcaStepPct = user.dcaStepPct ? Number(user.dcaStepPct) : 2;
  const vaultAsset = (user.vaultAsset || 'usdt').toLowerCase();
  const heldCurrencies = balances
    .filter(
      (b: any) =>
        String(b.currency).toLowerCase() !== quote &&
        String(b.currency).toLowerCase() !== vaultAsset && // la bóveda no se opera
        Number(b.total ?? 0) > 0,
    )
    .map((b: any) => String(b.currency).toLowerCase());
  const symbols = await resolveSymbols(user.symbols, profile, client, heldCurrencies, quote);

  // Reconciliación: las monedas que el usuario YA tenía (capital inicial/depósitos)
  // deben registrarse como Position para que el ejecutor pueda aplicarles SL/TP y
  // rotarlas para fondear compras. Sin esto, quedaban "invisibles" y bloqueadas.
  for (const b of balances) {
    const cur = String(b.currency).toLowerCase();
    if (cur === quote) continue;
    const amount = Number(b.total ?? 0);
    if (amount <= 0) continue;
    const sym = `${cur}_${quote}`;
    const existing = await prisma.position.findUnique({ where: { userId_symbol: { userId, symbol: sym } } });
    const realTotal = Number(b.total ?? 0);
    if (existing) {
      // Mantén la cantidad sincronizada con el saldo real (evita vender de más).
      if (Math.abs(realTotal - Number(existing.baseAmount)) > 1e-9) {
        await prisma.position
          .update({ where: { userId_symbol: { userId, symbol: sym } }, data: { baseAmount: String(realTotal) } })
          .catch(() => {});
      }
      continue;
    }
    try {
      const t = await client.ticker(sym);
      const price = Number(t.last ?? 0);
      const value = amount * price;
      const lim = limits.get(sym);
      // Solo monedas con par MXN válido y valor por encima del mínimo vendible.
      if (price <= 0 || (lim && (amount < lim.minimumAmount || value < lim.minimumValue))) continue;
      if (value < 5) continue; // ignora polvo
      await prisma.position.create({
        data: { userId, symbol: sym, baseAmount: String(amount), avgCostMxn: String(price) },
      });
      await logEvent(userId, `📌 Posición registrada ${sym} (${amount.toFixed(6)}) al precio actual — capital previo`, 'info');
    } catch {}
  }

  const botSetting = await prisma.setting.findUnique({ where: { key: 'bot' } });
  const regimeFilter = (botSetting?.value as any)?.regimeFilter !== false;
  let regime: Awaited<ReturnType<typeof getRegime>> | null = null;
  try {
    regime = await getRegime();
  } catch {}
  if (regime) {
    await logEvent(userId, `Régimen: ${regime.zone} (${regime.score}/100)`, regime.zone === 'RISK_OFF' ? 'warn' : 'info');
  }

  // ── Bóveda de ganancias (moneda estable) ───────────────────────────
  // El bot opera SOLO con el capital invertido (capital inicial + depósitos).
  // La ganancia se mueve a una MONEDA ESTABLE (USDC/USDT) y NO se opera.
  const deps = await prisma.deposit.findMany({ where: { userId } });
  const netDeposits = deps.reduce(
    (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
    0,
  );
  const workingCapital = (user.initialCapital ? Number(user.initialCapital) : 0) + netDeposits;

  // Valor actual de la bóveda (posiciones reservadas).
  const reservedPositions = await prisma.position.findMany({ where: { userId, reserved: true } });
  let vaultValue = 0;
  for (const p of reservedPositions) {
    try {
      const t = await client.ticker(p.symbol);
      vaultValue += Number(p.baseAmount) * Number(t.last ?? 0);
    } catch {}
  }

  let equityQuote = Math.max(0, equityMxn - vaultValue);
  if (quote !== 'mxn') {
    try {
      const t = await client.ticker(`${quote}_mxn`);
      const p = Number(t.last ?? 0);
      if (p > 0) equityQuote = equityQuote / p;
    } catch {}
  }
  const cryptoValue = Math.max(0, equityQuote - cashAvailable);
  let profitReserve = Math.max(0, equityQuote - workingCapital);
  if (movements.withdrawn > 0) {
    // Retiro detectado automáticamente → REINICIA la bóveda (vuelve a $0).
    profitReserve = 0;
    await prisma.user
      .update({ where: { id: userId }, data: { vaultBasePnl: String(equityQuote - workingCapital) } })
      .catch(() => {});
    await logEvent(userId, `🔄 Bóveda reiniciada por retiro detectado ($${movements.withdrawn.toFixed(2)})`, 'ok');
  }

  // Mueve la ganancia a la moneda estable de la bóveda (no se opera).
  const cashReserveAmount = equityMxn * (cashReservePct / 100);
  if (quote === 'mxn' && user.vaultEnabled && profitReserve >= 10) {
    const vsym = `${vaultAsset}_mxn`;
    const lim = limits.get(vsym);
    const minVal = Math.max(1, lim?.minimumValue ?? 1);
    let sweep = Math.min(profitReserve, cashAvailable - cashReserveAmount);
    if (sweep < minVal) sweep = 0;
    if (sweep > 0) {
      try {
        const t = await client.ticker(vsym);
        const price = Number(t.last ?? 0);
        if (price > 0) {
          const order = await client.placeOrder({ book: vsym, side: 'buy', type: 'market', minor: String(Math.round(sweep * 100) / 100) });
          await prisma.trade.create({
            data: {
              userId, symbol: vsym, side: 'BUY', amount: String(Math.round(sweep * 100) / 100), price: String(price),
              status: 'PENDING', source: 'AI', reason: 'Bóveda de ganancias (moneda estable)',
              externalId: order?.oid ? String(order.oid) : null,
            },
          });
          const qty = sweep / price;
          const ex = await prisma.position.findUnique({ where: { userId_symbol: { userId, symbol: vsym } } });
          const oldQty = ex ? Number(ex.baseAmount) : 0;
          const oldCost = ex ? Number(ex.avgCostMxn) : 0;
          const newQty = oldQty + qty;
          const newAvg = newQty > 0 ? (oldQty * oldCost + qty * price) / newQty : price;
          await prisma.position.upsert({
            where: { userId_symbol: { userId, symbol: vsym } },
            update: { baseAmount: String(newQty), avgCostMxn: String(newAvg), reserved: true },
            create: { userId, symbol: vsym, baseAmount: String(newQty), avgCostMxn: String(newAvg), reserved: true },
          });
          profitReserve = Math.max(0, profitReserve - sweep);
          await logEvent(userId, `🏦 Bóveda: moví $${sweep.toFixed(2)} de ganancia a ${vaultAsset.toUpperCase()} (no se opera)`, 'ok');
        }
      } catch (err) {
        await logEvent(userId, `No se pudo mover a la bóveda: ${(err as Error).message.slice(0, 50)}`, 'warn');
      }
    }
  }

  const reservePct = cashReserveAmount;
  // Efectivo disponible para operar (sin tocar la bóveda).
  let cashRemaining = Math.max(0, Math.min(cashAvailable - profitReserve - reservePct, workingCapital - cryptoValue));
  if (profitReserve > 0.5 || vaultValue > 0.5) {
    await logEvent(
      userId,
      `💰 Ganancias: $${profitReserve.toFixed(2)} en caja · bóveda ${vaultAsset.toUpperCase()}: $${vaultValue.toFixed(2)}`,
      'info',
    );
  }

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
      const pnlPct = posQty > 0 && avg > 0 && last > 0 ? ((last - avg) / avg) * 100 : null;

      // Indicadores técnicos reales (RSI, tendencia, ATR, momentum...) para el prompt.
      const indicators = await getIndicators(base).catch(() => null);

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
        indicators,
        regime: regime ? { zone: regime.zone, score: regime.score } : null,
        pnlPct,
      };

      const signal = await generateSignal(symbol, ctx);

      // OVERRIDE ESTADÍSTICO: si la estadística dice BARATO y el spread es bajo,
      // el bot COMPRA aunque la IA haya respondido HOLD (la IA solo puede vetar con SELL).
      const bid0 = Number(ticker.bid ?? 0);
      const ask0 = Number(ticker.ask ?? 0);
      const mid0 = bid0 > 0 && ask0 > 0 ? (bid0 + ask0) / 2 : last;
      const spread0 = mid0 > 0 && ask0 > bid0 ? ((ask0 - bid0) / mid0) * 100 : 0;
      if (indicators && indicators.stat === 'BARATO' && signal.action === 'HOLD' && spread0 <= 0.6 && last > 0) {
        signal.action = 'BUY';
        signal.confidence = Math.max(signal.confidence, 0.6);
        signal.reasoning = `BARATO z=${indicators.zScore} RSI=${indicators.rsi} (estadística)`;
        await logEvent(
          userId,
          `📈 Override estadístico ${symbol} → BUY (barato: z=${indicators.zScore}, RSI=${indicators.rsi}, spread ${spread0.toFixed(2)}%)`,
          'ok',
        );
      }

      await prisma.signal.create({
        data: {
          userId, symbol, action: signal.action, confidence: signal.confidence, reasoning: signal.reasoning,
          tokensUsed: signal.tokensUsed, latencyMs: signal.latencyMs, executed: false,
        },
      });
      await logEvent(userId, `${symbol} → ${signal.action} (${(signal.confidence * 100).toFixed(0)}%)`, signal.action === 'HOLD' ? 'info' : 'ok');

      if (!user.autoTrade || signal.action === 'HOLD' || signal.confidence < minConf) continue;

      // Si la IA ahora pide VENDER, cancela las escaleras de compra pendientes del par
      // (evita planes contradictorios que se ejecutarían a la vez).
      if (signal.action === 'SELL') {
        await clearPending(userId, symbol);
      }

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

        // Respetar mínimos del exchange (monto y valor por orden) antes de crear el plan
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
        // Niveles por operación: usa los de la IA si son coherentes; si no, los del usuario.
        const sl = signal.stopLossPrice > 0 && signal.stopLossPrice < entry
          ? signal.stopLossPrice
          : stopLossPct > 0 ? entry * (1 - stopLossPct / 100) : 0;
        const tp = signal.takeProfitPrice > 0 && signal.takeProfitPrice > entry
          ? signal.takeProfitPrice
          : takeProfitPct > 0 ? entry * (1 + takeProfitPct / 100) : 0;
        for (let i = 0; i < levels; i++) {
          const price = entry * (1 - (i * dcaStepPct) / 100);
          await prisma.instruction.create({
            data: {
              userId, symbol, side: 'BUY', trigger: 'price_below', triggerPrice: String(price),
              amountMxn: String(per), reason: `${signal.reasoning} (DCA ${i + 1}/${levels})`, status: 'PENDING', expiresAt: expires,
              slPriceMxn: sl > 0 ? String(sl) : null, tpPriceMxn: tp > 0 ? String(tp) : null,
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
          await logEvent(userId, `Venta de ${symbol} no cumple el mínimo del exchange · se omite`, 'warn');
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
