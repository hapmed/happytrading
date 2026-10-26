import { prisma } from '../lib/prisma.js';
import { kv } from '../lib/kv.js';
import { generateSignal } from './ai.js';
import { makeExchangeClient, hasExchangeCreds, type ExchangeClient } from '../lib/exchange.js';
import { redeemAllEarn } from '../lib/earn.js';
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
const PLAN_TTL_H = 2; // validez de cada instrucción (corto plazo: si no entra en 2h, caduca)

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
/**
 * Rota capital: vende posiciones para fondear una compra mejor.
 *  - Normal: vende la posición con mejor relación ganancia/tamaño (no descapitaliza).
 *  - Oportunidad IMPERDIBLE (`preferWorst`): vende primero las que MENOS ganan
 *    (aunque sea con pérdida) y hasta `needed` para no dejar pasar la oferta.
 */
async function tryRotate(
  userId: string,
  excludeSymbol: string,
  client: ExchangeClient,
  opts: { preferWorst?: boolean; needed?: number; max?: number; limits?: Map<string, BookLimits> } = {},
): Promise<number> {
  const positions = await prisma.position.findMany({ where: { userId, baseAmount: { gt: 0 }, reserved: false } });
  const others = positions.filter((p) => p.symbol !== excludeSymbol);
  if (!others.length) return 0;

  // Evalúa cada posición candidata (valor real, PnL y liquidez).
  const cands: Array<{ symbol: string; qty: number; price: number; value: number; pnlPct: number }> = [];
  for (const p of others) {
    try {
      const t = await client.ticker(p.symbol);
      const price = Number(t.last ?? 0);
      const qty = Number(p.baseAmount);
      const value = qty * price;
      if (value <= 0 || price <= 0) continue;
      // Solo posiciones realmente VENDIBLES (si no, no tiene sentido rotar polvo).
      const limR = opts.limits?.get(p.symbol);
      if (limR && (value < limR.minimumValue || qty < limR.minimumAmount)) continue;
      const avg = Number(p.avgCostMxn);
      const pnlPct = avg > 0 ? ((price - avg) / avg) * 100 : 0;
      cands.push({ symbol: p.symbol, qty, price, value, pnlPct });
    } catch {}
  }
  if (!cands.length) return 0;

  // Imperdible → corta primero las perdedoras (menor PnL). Normal → la más rentable/grande.
  cands.sort((a, b) =>
    opts.preferWorst
      ? a.pnlPct - b.pnlPct
      : b.pnlPct + (b.value >= 20 ? 10 : 0) - (a.pnlPct + (a.value >= 20 ? 10 : 0)),
  );

  const needed = opts.needed && opts.needed > 0 ? opts.needed : 0;
  const maxSell = Math.max(1, opts.max ?? 1); // imperdible: vende varias si hace falta
  let freed = 0;
  let sold = 0;
  for (const c of cands) {
    if (sold >= maxSell) break;
    if (needed > 0 && freed >= needed) break;
    await prisma.instruction.create({
      data: {
        userId, symbol: c.symbol, side: 'SELL', trigger: 'immediate', triggerPrice: String(c.price),
        quantity: String(c.qty), reason: `Rotar → ${excludeSymbol}${opts.preferWorst ? ' (imperdible)' : ''}`,
        status: 'PENDING', expiresAt: new Date(Date.now() + 3600 * 1000),
      },
    });
    await logEvent(
      userId,
      `🔄 Rotando: vendo ${c.symbol} (${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct.toFixed(1)}%) para comprar ${excludeSymbol}${opts.preferWorst ? ' · ¡oportunidad imperdible!' : ''}`,
      'warn',
    );
    freed += c.value;
    sold++;
  }
  return freed;
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

  // ⏸ Si el automático está apagado, el bot se DETIENE (no gasta tokens ni opera).
  if (!user.autoTrade) {
    await logEvent(userId, '⏸ Bot detenido: el automático está APAGADO (enciéndelo para operar)', 'warn');
    await setState(userId, 'idle', 'Detenido · automático OFF');
    return;
  }

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

  // Los fondos deben estar SIEMPRE bajo nuestro control: si Binance los metió en
  // Simple Earn (aparecen como LD*), los regresamos a Spot antes de planear.
  try {
    const rescued = await redeemAllEarn(client);
    if (rescued.length) {
      await logEvent(
        userId,
        `🏖️ Rescaté de Simple Earn: ${rescued.map((r) => `${r.amount} ${r.asset.toUpperCase()}`).join(', ')} → ya bajo control del bot`,
        'info',
      );
    }
  } catch {}

  let balances: any[];
  try {
    balances = await client.balance();
  } catch (err) {
    await logEvent(userId, `Error de conexión: ${(err as Error).message}`, 'error');
    await setState(userId, 'error', 'Error de conexión');
    throw err;
  }
  await logEvent(userId, `Saldo leído · ${balances.length} monedas`, 'info');

  // Recuperar fondos de FUTUROS → Spot: deben estar en la bolsa de inversión
  // (si no, la app no los ve y el bot no los puede usar).
  try {
    const fut = await (client as any).futuresBalance?.();
    const f = fut?.find((b: any) => b.currency === quote);
    const canMove = Number(f?.maxWithdraw ?? 0); // solo lo realmente transferible
    const avail = Number(f?.available ?? 0);
    const total = Number(f?.total ?? 0);
    if (canMove > 0.1) {
      await (client as any).transfer('UMFUTURE_MAIN', quote.toUpperCase(), Number((canMove * 0.999).toFixed(6)));
      await logEvent(userId, `💼 Rescaté ${canMove.toFixed(4)} ${quote.toUpperCase()} de Futuros → a la bolsa de Spot`, 'info');
      balances = await client.balance();
    } else if (total > 0.1) {
      await logEvent(
        userId,
        `⚠️ Tienes ${total.toFixed(4)} ${quote.toUpperCase()} en Futuros pero NO son transferibles (disponible ${avail.toFixed(4)} · ¿hay una posición abierta?).`,
        'warn',
      );
    }
  } catch (err) {
    await logEvent(userId, `No pude rescatar el saldo de Futuros: ${(err as Error).message.slice(0, 90)}`, 'warn');
  }

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

  // ── Auto-restauración: si Binance vació la bóveda (auto-sweep), la reponemos ──
  try {
    const funding = await (client as any).fundingBalance?.();
    const fq = Number(funding?.find((b: any) => b.currency === quote)?.available ?? 0);
    const expectedRaw = await kv.get(`vault:expected:${userId}`);
    let expected = Number(expectedRaw ?? 0);
    // Primera vez: establecer la base con lo que ya hay guardado (no inventar ganancias).
    if (!expectedRaw && fq > 0) {
      expected = fq;
      await kv.set(`vault:expected:${userId}`, String(fq));
    }
    if (expected > 0 && fq < expected - 0.01) {
      const missing = expected - fq;
      const canMove = Math.min(missing, cashAvailable);
      if (canMove >= 0.01) {
        await (client as any).transfer('MAIN_FUNDING', quote.toUpperCase(), Number(canMove.toFixed(6)));
        await logEvent(userId, `🛡️ Binance vació la bóveda (auto-sweep): la repongo con ${canMove.toFixed(4)} ${quote.toUpperCase()} — ya bajo control del bot`, 'warn');
      } else {
        await logEvent(userId, `🛡️ Binance vació la bóveda pero no hay efectivo para reponerla (faltan ${missing.toFixed(4)})`, 'warn');
      }
    }
  } catch {}
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
      // Solo pares que ALCANCEN con holgura AL TAMAÑO DE ORDEN (micro-op): así todo
      // lo que compre será vendible y nunca trabará capital en algo que no se vende.
      const lim0 = limits.get(sym);
      if (lim0 && lim0.minimumValue * 1.3 > Math.min(cashRemaining, maxOrder)) continue;
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

  // 📡 COBERTURA DINÁMICA: más capital → más monedas vigiladas.
  //    La IA analiza estas; el WORKER las vigila TODAS cada ~30s con sus niveles.
  const watched = Math.max(
    volatileTop,
    Math.min(20, Math.round(Math.max(0, cashRemaining) / Math.max(0.5, maxOrder)) + 3),
  );

  // Selección: entre los más volátiles, PRIORIZA los que están BARATOS (estadística).
  const pool = ranked.slice(0, Math.max(10, watched * 3)).map((r) => r.symbol);
  const cheap: string[] = [];
  for (const sym of pool) {
    try {
      const ind = await getIndicators(sym.split('_')[0]);
      if (ind && (ind.stat === 'BARATO' || Number(ind.bbPos) <= 25)) cheap.push(sym);
    } catch {}
  }
  const ordered = [...cheap, ...ranked.map((r) => r.symbol)];
  const selected = (watched > 0 ? uniq(ordered).slice(0, watched + 1) : ordered);
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
      // No "resucitar" posiciones de POLVO: si el saldo no alcanza el mínimo del
      // exchange, no es vendible → no se registra ni se intenta operar.
      const limOrphan = limits.get(symbol);
      const orphanTradable =
        !limOrphan || (baseAvailable * last >= limOrphan.minimumValue && baseAvailable >= limOrphan.minimumAmount);
      if (!pos && baseAvailable > 0 && orphanTradable) {
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
        (indicators.stat === 'BARATO' ||
          Number(indicators.zScore) <= -1.2 ||
          Number(indicators.bbPos) <= 20 ||
          Number(indicators.rsi) <= 32);
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
        if (evPct <= 0.25) {
          await logEvent(userId, `🧮 ${symbol}: EV ${evPct.toFixed(2)}% ≤ 0.25 (p=${(pWin * 100).toFixed(0)}%) → no conviene`, 'info');
          continue;
        }
        const b = slE > 0 ? tpE / slE : 1;
        const kelly = b > 0 ? Math.max(0, (pWin * b - (1 - pWin)) / b) : 0;

        // 🔥 IMPERDIBLE: barra ALTÍSIMA. Rotar cuesta comisiones + realizar pérdidas,
        //    así que solo se rota si la oportunidad es excepcional (raro a propósito).
        const cheapDeep =
          z <= -1.5 || Number(indicators?.bbPos ?? 100) <= 15 || Number(indicators?.rsi ?? 100) <= 30;
        const imperdible = evPct >= 1.2 && cheapDeep && spreadPPct <= 0.8 && signal.confidence >= 0.8;
        if (imperdible) {
          await logEvent(
            userId,
            `🔥 OPORTUNIDAD IMPERDIBLE en ${symbol} (EV +${evPct.toFixed(2)}% · z=${z.toFixed(2)} · pos_bandas=${indicators?.bbPos}% · RSI=${indicators?.rsi} · spread ${spreadPPct.toFixed(2)}%) → vendo lo necesario para comprarla`,
            'ok',
          );
        }
        await logEvent(
          userId,
          `🧮 ${symbol}: EV +${evPct.toFixed(2)}% · p=${(pWin * 100).toFixed(0)}% · Kelly ${(kelly * 100).toFixed(0)}% · spread ${spreadPPct.toFixed(2)}% → COMPRO`,
          'ok',
        );
        // 🎯 CONFIANZA ALTA = "ganancia segura": SIN TOPE → invierte TODA la caja
        //    (y rota/vende lo que haga falta para fondearla). Debe ser rápido.
        const sureGain = signal.confidence >= 0.75 && cheapDeep && spreadPPct <= 1.2;
        const cap = sureGain ? cashRemaining : maxOrder;
        if (sureGain) {
          await logEvent(
            userId,
            `🎯 GANANCIA SEGURA en ${symbol} (conf ${(signal.confidence * 100).toFixed(0)}% · z=${z.toFixed(2)} · RSI=${indicators?.rsi} · EV +${evPct.toFixed(2)}%) → SIN TOPE: invierto toda la caja ($${cashRemaining.toFixed(2)})`,
            'ok',
          );
        }
        await logEvent(
          userId,
          `🧮 ${symbol}: EV +${evPct.toFixed(2)}% · p=${(pWin * 100).toFixed(0)}% · Kelly ${(kelly * 100).toFixed(0)}% · spread ${spreadPPct.toFixed(2)}% → COMPRO`,
          'ok',
        );
        // SIZING: maxOrder es el TECHO normal; la IA puede pedir menos (size 0.2..1).
        // Pero si es "ganancia segura", el techo desaparece y usa toda la caja.
        const sizeFactor = signal.size && signal.size > 0 ? Math.max(0.2, Math.min(1, signal.size)) : 1;
        const size = sureGain ? cap : maxOrder * sizeFactor;
        let spend = Math.min(size, cashRemaining);
        const entry = signal.entryPrice && signal.entryPrice > 0 ? signal.entryPrice : last;

        // Respetar mínimos del exchange (monto y valor por orden) antes de crear el plan
        const lim = limits.get(symbol);
        const minValue = lim?.minimumValue ?? 0;
        const minAmount = lim?.minimumAmount ?? 0;
        const minPerTranche = Math.max(minValue, minAmount * entry);
        // Margen 30%: garantiza que la posición siga siendo VENDIBLE aunque el precio caiga.
        const minSellable = Math.max(1, minPerTranche * 1.3);

        // ROTA para fondear esta compra:
        //  - Normal: solo si no alcanza el mínimo para operar.
        //  - Imperdible / Segura: hasta llenar el objetivo (vende lo que sea, aunque pierda).
        const bigBet = sureGain || imperdible;
        const target = bigBet ? Math.max(cap, minSellable) : minSellable;
        if (spend < target && rotate) {
          const freedValue = await tryRotate(userId, symbol, client, {
            preferWorst: true,
            needed: target - spend,
            max: bigBet ? 8 : 1,
            limits,
          });
          if (freedValue > 0) spend = Math.min(cap, spend + freedValue);
        }
        if (spend < minSellable) {
          await logEvent(
            userId,
            `⏭ ${symbol}: no alcanza para una posición vendible (mín ${minSellable.toFixed(2)} ${quote.toUpperCase()}) · se omite`,
            'warn',
          );
          continue;
        }
        let levels = dcaLevels;
        if (minSellable > 0) levels = Math.max(1, Math.min(dcaLevels, Math.floor(spend / minSellable)));
        cashRemaining = Math.max(0, cashRemaining - spend);
        const per = spend / levels;
        const expires = new Date(Date.now() + PLAN_TTL_H * 3600 * 1000);
        // Niveles por operación: usa los de la IA si son coherentes; si no, los del usuario.
        // Niveles por operación: MANDA la configuración del usuario (TP corto para
        // capturar la fluctuación); si no hay, usa los que propuso la IA.
        const sl = stopLossPct > 0
          ? entry * (1 - stopLossPct / 100)
          : signal.stopLossPrice > 0 && signal.stopLossPrice < entry ? signal.stopLossPrice : 0;
        const tp = takeProfitPct > 0
          ? entry * (1 + takeProfitPct / 100)
          : signal.takeProfitPrice > 0 && signal.takeProfitPrice > entry ? signal.takeProfitPrice : 0;
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
