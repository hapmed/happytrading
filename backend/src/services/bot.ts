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
  aggressive: [
    'btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn', 'ltc_mxn', 'trx_mxn', 'mana_mxn',
    'ada_mxn', 'doge_mxn', 'avax_mxn', 'link_mxn', 'dot_mxn', 'atom_mxn', 'uni_mxn', 'aave_mxn',
    'near_mxn', 'algo_mxn', 'sand_mxn', 'gala_mxn', 'enj_mxn', 'chz_mxn', 'xtz_mxn', 'xlm_mxn',
    'vet_mxn', 'hbar_mxn', 'theta_mxn', 'zil_mxn', 'bat_mxn', 'snx_mxn', 'crv_mxn', 'comp_mxn',
    'mkr_mxn', 'yfi_mxn', 'rune_mxn', 'kava_mxn', 'band_mxn', 'ocean_mxn', 'storj_mxn', 'grt_mxn',
    'imx_mxn', 'dydx_mxn', 'gmx_mxn', 'arb_mxn', 'op_mxn', 'sei_mxn', 'tia_mxn', 'wld_mxn', 'jup_mxn', 'pyth_mxn',
  ],
};
const MIN_CONF: Record<string, number> = { conservative: 0.7, balanced: 0.55, aggressive: 0.3 };
const DEFAULT_ORDER_MXN = 200;
const PLAN_TTL_H = 8; // validez de cada instrucción

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

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
    .filter((s) => !s.startsWith(`${quote}_`) && (!books.length || validSet.has(s)));
  // Pares de mínimo bajo (1 USDT) y alta volatilidad: permiten operar con poco capital.
  const MICRO = ['doge', 'pepe', 'shib', 'floki', 'bonk', 'wif', 'bome', 'pengu', 'trump', 'neiro', 'turbo', 'act', 'pnut'];
  const microList = quote === 'usdt' ? MICRO.map((m) => `${m}_usdt`).filter((s) => !books.length || validSet.has(s)) : [];

  let base: string[];
  if (c === 'auto') {
    // 'auto' usa TODOS los pares, pero si son demasiados (Binance tiene cientos)
    // usamos la lista del perfil + las memecoins de mínimo bajo (para poco capital).
    base = qBooks.length && qBooks.length <= 60 ? qBooks : [...def, ...microList];
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

  // Movimientos FIAT (MXN/SPEI): depósitos = inversión; retiros = salida.
  try {
    const fm = await (client as any).fiatMovements?.();
    for (const m of fm ?? []) {
      try {
        const wid = String(m?.wid ?? '');
        if (!wid) continue;
        const createdMs = new Date(m?.created_at ?? 0).getTime();
        if (!(createdMs > Date.now() - 365 * 864e5)) continue;
        const note = `binance-fiat:${m.kind}:${wid}`;
        if (await prisma.deposit.findFirst({ where: { userId, note } })) continue;
        const amount = Number(m?.amount ?? 0);
        if (!(amount > 0)) continue;
        await prisma.deposit.create({
          data: { userId, currency: 'mxn', amount: String(amount), kind: m.kind, note },
        });
        await logEvent(
          userId,
          `${m.kind === 'DEPOSIT' ? '⬇ Depósito MXN (inversión)' : '⬆ Retiro MXN'}: $${amount.toFixed(2)}`,
          'ok',
        );
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
  // Efectivo para OPERAR = solo Spot (la bóveda vive en Funding y no se toca).
  let cashAvailable = Number(cashBal?.available ?? '0');
  try {
    const sp = await (client as any).spotBalance?.();
    if (sp) cashAvailable = Number(sp.find((b: any) => b.currency === quote)?.available ?? 0);
  } catch {}

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

  // ── Capital de trabajo y retiro automático a la CLABE ──────────────
  // El bot opera SOLO con el capital invertido (capital inicial + depósitos).
  // La ganancia por encima se transfiere a tu banco (SPEI → CLABE) si está activado.
  const deps = await prisma.deposit.findMany({ where: { userId } });
  const netDeposits = deps.reduce(
    (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
    0,
  );
  const investedMxn = (user.initialCapital ? Number(user.initialCapital) : 0) + netDeposits;

  // Precio de la cotización en MXN (USDT→MXN) para convertir.
  let quoteToMxn = 1;
  if (quote !== 'mxn') {
    try {
      const t = await client.ticker(`${quote}_mxn`);
      const p = Number(t.last ?? 0);
      if (p > 0) quoteToMxn = p;
    } catch {}
  }
  const equityQuote = equityMxn / quoteToMxn;
  const investedQuote = investedMxn / quoteToMxn;

  // ── Bóveda: ganancia acumulada desde el último retiro (hacia los $50) ──
  const pnlMxn = equityMxn - investedMxn;
  if (movements.withdrawn > 0) {
    await prisma.user.update({ where: { id: userId }, data: { vaultBasePnl: String(pnlMxn) } }).catch(() => {});
    await logEvent(userId, `💰 Retiro detectado ($${movements.withdrawn.toFixed(2)}) → bóveda reiniciada`, 'ok');
  }
  const vaultBasePnl = user.vaultBasePnl ? Number(user.vaultBasePnl) : 0;
  const vaultMxn = Math.max(0, pnlMxn - vaultBasePnl);
  const profitReserve = vaultMxn / quoteToMxn; // ganancia (en cotización) que NO se reinvierte
  const cryptoValue = Math.max(0, equityQuote - cashAvailable);

  const cashReserveAmount = equityQuote * (cashReservePct / 100);

  // ── BÓVEDA: guarda TODA la ganancia REALIZADA en Funding (USDT estable, no varía) ──
  // Se mueve cualquier excedente por encima del capital. Una vez ahí NO se toca.
  try {
    const funding = await (client as any).fundingBalance?.();
    const fundingQuote = Number(funding?.find((b: any) => b.currency === quote)?.available ?? 0);
    const realizedCash = Math.max(0, cashAvailable - investedQuote); // efectivo SOBRE tu capital
    const pending = Math.max(0, realizedCash - fundingQuote);
    if (pending >= 0.005) {
      const move = Math.min(pending, cashAvailable);
      await (client as any).transfer('MAIN_FUNDING', quote.toUpperCase(), Number(move.toFixed(6)));
      await logEvent(
        userId,
        `🏦 Bóveda: guardé ${move.toFixed(4)} ${quote.toUpperCase()} (~$${(move * quoteToMxn).toFixed(2)} MXN) — ya no se mueve`,
        'ok',
      );
    }
  } catch (err) {
    await logEvent(userId, `No se pudo guardar en la bóveda: ${(err as Error).message.slice(0, 60)}`, 'warn');
  }

  // ── Retiro automático de ganancias a la CLABE (Binance → SPEI) ─────
  const PAYOUT_MIN_MXN = 50; // mínimo de retiro SPEI en Binance (verificado en su API)
  if (user.payoutEnabled && user.payoutClabe && user.payoutBeneficiary) {
    try {
      const payoutKey = `payout:${userId}:${new Date().toISOString().slice(0, 13)}`; // máx 1/hora
      if (!(await kv.get(payoutKey))) {
        const funding = await (client as any).fundingBalance?.();
        const fq = Number(funding?.find((b: any) => b.currency === quote)?.available ?? 0);
        const vaultMxnEq = fq * quoteToMxn;
        if (vaultMxnEq >= PAYOUT_MIN_MXN) {
          const amount = Math.round(vaultMxnEq * 100) / 100;
          // Traer la bóveda (USDT) de Funding → Spot, convertir a MXN y retirar por SPEI.
          await (client as any).transfer('FUNDING_MAIN', quote.toUpperCase(), Number(fq.toFixed(4)));
          await new Promise((r) => setTimeout(r, 3000));
          await (client as any).convert(quote.toUpperCase(), 'MXN', Number(fq.toFixed(2)));
          await new Promise((r) => setTimeout(r, 2500));
          const sp = await (client as any).spotBalance?.();
          const mxnSpot = Number(sp?.find((b: any) => b.currency === 'mxn')?.available ?? 0);
          const send = Math.min(mxnSpot, amount);
          if (send >= 50) {
            const w = await (client as any).fiatWithdrawMxn({
              amountMxn: Math.round(send * 100) / 100,
              clabe: user.payoutClabe,
              beneficiary: user.payoutBeneficiary,
              bank: user.payoutBank ?? undefined,
            });
            await prisma.deposit.create({
              data: { userId, currency: 'mxn', amount: String(Math.round(send * 100) / 100), kind: 'WITHDRAWAL', note: `binance-spei:${w?.orderId ?? w?.id ?? 'retiro'}` },
            });
            await kv.set(payoutKey, '1', 3600);
            await logEvent(userId, `🏦 Retiro automático a tu CLABE: $${send.toFixed(2)} MXN`, 'ok');
          }
        }
      }
    } catch (err) {
      await logEvent(userId, `No se pudo retirar a la CLABE: ${(err as Error).message.slice(0, 70)}`, 'warn');
    }
  }

  const reservePct = cashReserveAmount;
  // Efectivo disponible para operar (sin tocar la bóveda).
  let cashRemaining = Math.max(0, Math.min(cashAvailable - profitReserve - reservePct, investedQuote - cryptoValue));
  await logEvent(
    userId,
    `💰 Bóveda: $${vaultMxn.toFixed(2)} / $${PAYOUT_MIN_MXN} (se transfiere a tu CLABE al llegar)`,
    'info',
  );

  // ── Ahorro de tokens: si no hay capital para operar, NO llamamos a la IA ──
  let minViable = Number.POSITIVE_INFINITY;
  for (const s of symbols) {
    const lim = limits.get(s);
    if (lim?.minimumValue && lim.minimumValue > 0) minViable = Math.min(minViable, lim.minimumValue);
  }
  if (!isFinite(minViable) || minViable <= 0) minViable = quote === 'usdt' ? 1 : 10;
  if (cashRemaining < minViable && cryptoValue <= 0.000001) {
    await logEvent(
      userId,
      `⏸ Sin fondos para operar (caja $${cashRemaining.toFixed(2)} · mínimo $${minViable.toFixed(2)} · ${symbols.length} pares) — IA en pausa para ahorrar tokens`,
      'warn',
    );
    await setState(userId, 'idle', 'Sin fondos · IA en pausa');
    return;
  }

  // ⚡ Selección VOLÁTIL: mide el movimiento (ticker) y se queda con las N más volátiles.
  const tickerCache = new Map<string, any>();
  const ranked: Array<{ symbol: string; vol: number }> = [];
  for (const sym of symbols) {
    try {
      // Solo pares que ALCANCEN con el efectivo disponible (evita planes imposibles)
      const lim0 = limits.get(sym);
      if (lim0 && lim0.minimumValue > cashRemaining) continue;
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

  // Selección: entre los más volátiles, PRIORIZA los que están BARATOS (estadística).
  const pool = ranked.slice(0, Math.max(10, volatileTop * 3)).map((r) => r.symbol);
  const cheap: string[] = [];
  for (const sym of pool) {
    try {
      const ind = await getIndicators(sym.split('_')[0]);
      if (ind && (ind.stat === 'BARATO' || Number(ind.bbPos) <= 25)) cheap.push(sym);
    } catch {}
  }
  const ordered = [...cheap, ...ranked.map((r) => r.symbol)];
  const selected = (volatileTop > 0 ? uniq(ordered).slice(0, volatileTop + 1) : ordered);
  if (selected.length) {
    await logEvent(
      userId,
      `⚡ Selección: ${selected
        .map((s) => {
          const v = (ranked.find((r) => r.symbol === s)?.vol ?? 0).toFixed(1);
          return `${s.split('_')[0].toUpperCase()} ${v}%${cheap.includes(s) ? '❄' : ''}`;
        })
        .join(' · ')}`,
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
      const cheapEnough =
        indicators &&
        (indicators.stat === 'BARATO' || Number(indicators.bbPos) <= 45 || Number(indicators.zScore) <= -0.25);
      if (cheapEnough && signal.action === 'HOLD' && spread0 <= 2 && last > 0) {
        signal.action = 'BUY';
        signal.confidence = Math.max(signal.confidence, 0.6);
        signal.reasoning = `BARATO z=${indicators.zScore} RSI=${indicators.rsi} (estadística)`;
        await logEvent(
          userId,
          `📈 Compro ${symbol} por BARATO (z=${indicators.zScore}, RSI=${indicators.rsi}, pos_bandas=${indicators.bbPos}%, spread ${spread0.toFixed(2)}%)`,
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

        // ── ESTADÍSTICA (modo AGRESIVO): Valor Esperado + Kelly ───────────
        const z = Number(indicators?.zScore ?? 0);
        const bidT = Number(ticker.bid ?? 0);
        const askT = Number(ticker.ask ?? 0);
        const midT = bidT > 0 && askT > 0 ? (bidT + askT) / 2 : last;
        const spreadPPct = midT > 0 && askT > bidT ? ((askT - bidT) / midT) * 100 : 0;
        const pWin = Math.min(0.82, Math.max(0.4, 0.5 - z * 0.12)); // más barato → más probable
        const tpE = takeProfitPct > 0 ? takeProfitPct : 1.5;
        const slE = stopLossPct > 0 ? stopLossPct : 1.5;
        const evPct = pWin * tpE - (1 - pWin) * slE;
        if (evPct <= 0.05) {
          await logEvent(userId, `🧮 ${symbol}: EV ${evPct.toFixed(2)}% ≤ 0 (p=${(pWin * 100).toFixed(0)}%) → no conviene`, 'info');
          continue;
        }
        const b = slE > 0 ? tpE / slE : 1;
        const kelly = b > 0 ? Math.max(0, (pWin * b - (1 - pWin)) / b) : 0;
        await logEvent(
          userId,
          `🧮 ${symbol}: EV +${evPct.toFixed(2)}% · p=${(pWin * 100).toFixed(0)}% · Kelly ${(kelly * 100).toFixed(0)}% · spread ${spreadPPct.toFixed(2)}% → COMPRO`,
          'ok',
        );
        // SIZING AGRESIVO: usar todo el margen disponible (hasta maxOrder).
        const size = maxOrder;
        let spend = Math.min(maxOrder, cashRemaining);
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
          // Nivel 1: entra YA (mercado) para no perder la fluctuación; el resto espera el dip.
          const trig = i === 0 ? 'immediate' : 'price_below';
          await prisma.instruction.create({
            data: {
              userId, symbol, side: 'BUY', trigger: trig, triggerPrice: String(price),
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
