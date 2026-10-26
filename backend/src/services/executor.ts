import { prisma } from '../lib/prisma.js';
import { kv } from '../lib/kv.js';
import { queueNotification } from '../lib/notify.js';
import { logEvent } from '../lib/activity.js';
import { getBookLimits, BookLimits } from '../lib/bookLimits.js';
import { makeExchangeClient, quoteOf, type ExchangeClient } from '../lib/exchange.js';
import { floorToStep, qtyStr } from '../lib/precision.js';
import { getIndicators } from '../lib/indicators.js';
import { redeemAllEarn } from '../lib/earn.js';

function roundStr(n: number, dp: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  const s = n.toFixed(dp);
  return s.replace(/\.?0+$/, '') || '0';
}

async function applyPosition(
  userId: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  qty: number,
  priceMxn: number,
  levels?: { sl?: number; tp?: number },
): Promise<void> {
  if (qty <= 0) return;
  const key = { userId_symbol: { userId, symbol } };
  const existing = await prisma.position.findUnique({ where: key });
  if (side === 'BUY') {
    const oldQty = existing ? Number(existing.baseAmount) : 0;
    const oldCost = existing ? Number(existing.avgCostMxn) : 0;
    const newQty = oldQty + qty;
    const newAvg = newQty > 0 ? (oldQty * oldCost + qty * priceMxn) / newQty : 0;
    // Conserva los niveles previos si esta compra no trae nuevos.
    const sl = levels?.sl && levels.sl > 0 ? String(levels.sl) : existing?.slPriceMxn ?? null;
    const tp = levels?.tp && levels.tp > 0 ? String(levels.tp) : existing?.tpPriceMxn ?? null;
    await prisma.position.upsert({
      where: key,
      update: { baseAmount: String(newQty), avgCostMxn: String(newAvg), slPriceMxn: sl, tpPriceMxn: tp, peakPrice: String(newAvg) },
      create: { userId, symbol, baseAmount: String(newQty), avgCostMxn: String(newAvg), slPriceMxn: sl, tpPriceMxn: tp, peakPrice: String(newAvg) },
    });
  } else if (existing) {
    const left = Math.max(0, Number(existing.baseAmount) - qty);
    // Si lo que queda ya es polvo (no vendible), se borra la posición en vez de dejarla.
    if (left * priceMxn < 1) {
      await prisma.position.delete({ where: key }).catch(() => {});
    } else {
      await prisma.position.update({ where: key, data: { baseAmount: String(left) } });
    }
  }
}

// Evita rotar demasiado seguido (máx. 1 vez por minuto por usuario)
const rotateCooldown = new Map<string, number>();

// Tras un reinicio, las instrucciones que quedaron "en proceso" se recuperan una vez.
let recoveredProcessing = false;

// Cuando el exchange bloquea por límites de cuenta, dejamos de intentar
// operaciones por un rato para no spamear peticiones.
let accountBlockedUntil = 0;
let accountBlockNoticeAt = 0;

// La rotación la decide el PLANNER (con lógica de "oportunidad imperdible").
// El worker sólo ejecuta; así no rota por planes viejos (evita churn y polvo).
const EXECUTOR_ROTATION = false;

/** ¿El error es un bloqueo por límites de cuenta del exchange? */
function isAccountLimitError(err: unknown): boolean {
  const e = err as any;
  return /allowed balance|funds protection|exceed your total|insufficient/i.test(String(e?.message ?? ''));
}

/**
 * 🏺 Guarda en la BÓVEDA la ganancia de una venta ganadora.
 * Nunca deja la bolsa de trabajo por debajo del colchón (para poder seguir operando).
 */
async function saveProfitToVault(
  userId: string,
  client: ExchangeClient,
  user: { quote?: string | null },
  symbol: string,
  profit: number,
  cashNow: number,
): Promise<number> {
  if (!(profit > 0.01)) return 0;
  const q = quoteOf(user as any).toUpperCase();
  const FLOOR = 2; // colchón mínimo (moneda de cotización) para seguir operando
  const movable = Math.min(profit, Math.max(0, cashNow - FLOOR));
  const amt = Number(movable.toFixed(2));
  if (amt < 0.01) {
    await logEvent(userId, `🏺 Ganancia de ${profit.toFixed(4)} ${q} en ${symbol}, pero la bolsa está baja: la dejo trabajando`, 'info');
    return 0;
  }
  try {
    await (client as any).transfer('MAIN_FUNDING', q, amt);
    // Track the expected vault level so we can restore it if Binance auto-sweeps it.
    try {
      const prev = Number((await kv.get(`vault:expected:${userId}`)) ?? 0);
      await kv.set(`vault:expected:${userId}`, String(prev + amt));
    } catch {}
    await logEvent(userId, `🏺 Ganancia ${symbol}: guardé ${amt.toFixed(2)} ${q} en la bóveda — ya no se mueve (de ahí sale tu retiro a la CLABE)`, 'ok');
    return amt;
  } catch (err) {
    await logEvent(userId, `No pude guardar la ganancia de ${symbol}: ${(err as Error).message.slice(0, 60)}`, 'warn');
    return 0;
  }
}

/**
 * Sin MXN suficiente: VENDE la posición más rentable (o la que alcance) para fondear la compra.
 * Sacrifica la posición actual para no perder una mejor oportunidad (la estrategia siempre busca ganar).
 */
async function rotateToFund(
  userId: string,
  excludeSymbol: string,
  needMxn: number,
  client: ExchangeClient,
  limits: Map<string, any>,
  availOf: (symbol: string) => number,
): Promise<string | null> {
  const lastT = rotateCooldown.get(userId) ?? 0;
  if (Date.now() - lastT < 180_000) return null; // máx. 1 rotación cada 3 min
  if (Date.now() < accountBlockedUntil) return null; // exchange bloqueado por límites de cuenta

  // Anti-churn: cada rotación cuesta spread + comisión. Tope de rotaciones por hora.
  const rotKey = `rot:${userId}:${new Date().getHours()}`;
  const rotCount = Number((await kv.get(rotKey)) ?? 0);
  if (rotCount >= 4) return null;

  const positions = await prisma.position.findMany({ where: { userId, baseAmount: { gt: 0 }, reserved: false } });
  const others = positions.filter((p) => p.symbol !== excludeSymbol);
  let best: { symbol: string; qty: number; price: number; value: number; score: number } | null = null;

  for (const p of others) {
    try {
      const t = await client.ticker(p.symbol);
      const price = Number(t.last ?? 0);
      // Capar por el saldo REAL disponible de esa moneda (evita 0379 Insufficient balance).
      const qty = Math.min(Number(p.baseAmount), availOf(p.symbol));
      const value = qty * price;
      if (value <= 0) continue;
      const lim = limits.get(p.symbol);
      if (lim && (qty < lim.minimumAmount || value < lim.minimumValue)) continue; // no se puede vender (bajo el mínimo)
      const avg = Number(p.avgCostMxn);
      const pnlPct = avg > 0 ? ((price - avg) / avg) * 100 : 0;
      const score = pnlPct + (value >= needMxn ? 20 : 0); // preferir las que ya ganan y cubren lo necesario
      if (!best || score > best.score) best = { symbol: p.symbol, qty, price, value, score };
    } catch {}
  }
  if (!best) {
    console.warn(`[rotateToFund] sin candidato para ${userId} (posiciones=${others.length}, need=${needMxn})`);
    return null;
  }

  try {
    rotateCooldown.set(userId, Date.now());
    // Vender solo lo necesario para fondear (venta parcial) si cumple los mínimos;
    // si no, vender la posición completa.
    const price = best.price;
    const lim = limits.get(best.symbol);
    const step = lim?.stepSize ?? 0;
    let sellQty = floorToStep(needMxn > 0 && price > 0 ? Math.min(best.qty, (needMxn / price) * 1.05) : best.qty, step);
    if (lim && (sellQty < lim.minimumAmount || sellQty * price < lim.minimumValue)) {
      const full = floorToStep(best.qty, step);
      if (full >= lim.minimumAmount && full * price >= lim.minimumValue) sellQty = full;
      else return null;
    }
    const placed = await client.placeOrder({ book: best.symbol, side: 'sell', type: 'market', major: qtyStr(sellQty, step) });
    await prisma.trade.create({
      data: {
        userId, symbol: best.symbol, side: 'SELL', amount: qtyStr(sellQty, step), price: String(best.price),
        status: 'PENDING', source: 'AI', reason: 'Rotar para fondear compra', externalId: placed?.oid ? String(placed.oid) : null,
      },
    });
    await applyPosition(userId, best.symbol, 'SELL', sellQty, best.price);
    await kv.set(rotKey, String(rotCount + 1), 3600).catch(() => {});
    return best.symbol;
  } catch (err) {
    console.error(`[rotateToFund] venta ${best.symbol} falló:`, (err as Error).message);
    if (isAccountLimitError(err)) {
      accountBlockedUntil = Date.now() + 10 * 60_000;
      if (Date.now() - accountBlockNoticeAt > 10 * 60_000) {
        accountBlockNoticeAt = Date.now();
        await logEvent(
          userId,
          '⛔ El exchange bloqueó la operación por límites de cuenta. Revisa tu cuenta en Binance.',
          'error',
        ).catch(() => {});
      }
    }
    return null;
  }
}

/**
 * EJECUTOR (worker "tonto", SIN IA):
 * - cumple las instrucciones de la IA comprobando precio/tiempo
 * - aplica Stop-Loss / Take-Profit de las posiciones abiertas
 * Corre seguido (p. ej. cada 20-30s) y es barato.
 */
export async function runExecutorAll(): Promise<void> {
  const users0 = await prisma.user.findMany({ where: { tradingEnabled: true, autoTrade: true } });
  // Construye el cliente de Binance de cada usuario.
  const clients = new Map<string, ExchangeClient>();
  const users: typeof users0 = [];
  for (const u of users0) {
    const c = await makeExchangeClient(u).catch(() => null);
    if (c) {
      clients.set(u.id, c);
      users.push(u);
    }
  }
  if (!users.length) return;

  // Recuperación tras reinicio: instrucciones que quedaron en PROCESSING vuelven a PENDING.
  if (!recoveredProcessing) {
    recoveredProcessing = true;
    await prisma.instruction
      .updateMany({ where: { status: 'PROCESSING' }, data: { status: 'PENDING' } })
      .catch(() => {});
  }

  const [instructions, positions] = await Promise.all([
    prisma.instruction.findMany({
      where: { status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.position.findMany({ where: { baseAmount: { gt: 0 }, reserved: false } }),
  ]);
  if (!instructions.length && !positions.length) return;

  // Símbolos a vigilar
  const symbols = new Set<string>();
  for (const i of instructions) symbols.add(i.symbol);
  for (const p of positions) symbols.add(p.symbol);

  const clientList = [...clients.values()];

  // Límites de libro: por exchange, con cache. (una key inválida no debe bloquear a todos)
  const limitsCache = new Map<string, Map<string, BookLimits>>();
  const getLimits = async (userId: string): Promise<Map<string, BookLimits>> => {
    const u = users.find((x) => x.id === userId);
    const exch = 'binance';
    let m = limitsCache.get(exch);
    if (!m) {
      for (const c of clientList) {
        try {
          m = await getBookLimits(c, exch);
          break;
        } catch {}
      }
      m = m ?? new Map();
      limitsCache.set(exch, m);
    }
    return m;
  };
  let limits: Map<string, BookLimits> = await getLimits(users[0].id);

  // Precios (una vez por símbolo) — SIN IA, con fallback entre clientes
  const priceMap = new Map<string, number>();
  for (const sym of symbols) {
    for (const c of clientList) {
      try {
        const t = await c.ticker(sym);
        priceMap.set(sym, Number(t.last ?? 0));
        break;
      } catch {}
    }
  }

  // Saldos por usuario (real, incluso para no comprar ni vender de más)
  const mxnMap = new Map<string, number>();
  const balMap = new Map<string, Map<string, { avail: number; total: number }>>();
  for (const u of users) {
    try {
      const clientU: any = clients.get(u.id)!;
      // Si Binance metió fondos en Simple Earn (LD*), los traemos a Spot para poder
      // operar: los fondos deben estar SIEMPRE bajo nuestro control.
      const rescued = await redeemAllEarn(clientU).catch(() => []);
      if (rescued.length) {
        await logEvent(
          u.id,
          `🏖️ Rescaté de Simple Earn: ${rescued.map((r) => `${r.amount} ${r.asset.toUpperCase()}`).join(', ')} → ya está en Spot, bajo control del bot`,
          'info',
        );
      }
      const bals = await clientU.balance();
      const cmap = new Map<string, { avail: number; total: number }>();
      for (const b of bals) {
        const cur = String(b.currency ?? '').toLowerCase();
        cmap.set(cur, { avail: Number(b.available ?? 0), total: Number(b.total ?? 0) });
      }
      balMap.set(u.id, cmap);
      mxnMap.set(u.id, cmap.get(quoteOf(u))?.avail ?? 0);
    } catch {}
  }
  /** Cantidad disponible REAL de la moneda base de un par (evita vender de más). */
  const availOf = (userId: string, symbol: string): number =>
    balMap.get(userId)?.get(symbol.split('_')[0])?.avail ?? 0;

  // AUTO-SANACIÓN: sincroniza TODAS las posiciones con el saldo REAL del exchange.
  // (Las comisiones/los precios de llenado desfasan la cantidad estimada; sin esto
  //  el bot intentaría vender más de lo que tiene y el exchange daría insufficient balance.)
  for (const u of users) {
    const cmap = balMap.get(u.id);
    if (!cmap) continue;
    const poss = await prisma.position.findMany({ where: { userId: u.id } });
    for (const p of poss) {
      const real = cmap.get(p.symbol.split('_')[0])?.total;
      if (real == null) continue;
      if (Math.abs(real - Number(p.baseAmount)) > 1e-9) {
        await prisma.position
          .update({ where: { id: p.id }, data: { baseAmount: String(real) } })
          .catch(() => {});
      }
    }
  }

  // 1) Cumplir instrucciones
  const soldKeys = new Set<string>();
  for (const ins of instructions) {
    const user = users.find((u) => u.id === ins.userId);
    if (!user) continue;
    const price = priceMap.get(ins.symbol) ?? 0;
    if (price <= 0) continue;

    const fire =
      ins.trigger === 'immediate' ||
      (ins.trigger === 'price_below' && price <= Number(ins.triggerPrice)) ||
      (ins.trigger === 'price_above' && price >= Number(ins.triggerPrice));
    if (!fire) continue;

    // Reclamo atómico: sólo un ciclo puede tomar la instrucción (evita órdenes duplicadas).
    const claimed = await prisma.instruction.updateMany({
      where: { id: ins.id, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count !== 1) continue;

    const client = clients.get(ins.userId)!;
    const release = () =>
      prisma.instruction.update({ where: { id: ins.id }, data: { status: 'PENDING' } }).catch(() => {});
    try {
      if (ins.side === 'BUY') {
        const minor = Number(ins.amountMxn ?? 0);
        const lim = limits.get(ins.symbol);
        const minNeed = Math.max(0.5, lim?.minimumValue ?? 0);
        if (!(minor > 0) || minor < minNeed) {
          await logEvent(user.id, `Plan cancelado ${ins.symbol}: monto bajo el mínimo ($${minor})`, 'warn');
          await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'CANCELLED' } });
          continue;
        }

        // ¿Alcanza el efectivo? La rotación la decide el PLANNER; el worker espera.
        const mxn = mxnMap.get(ins.userId) ?? 0;
        if (minor > mxn) {
          const sold = EXECUTOR_ROTATION
            ? await rotateToFund(ins.userId, ins.symbol, minor, client, limits, (s) => availOf(ins.userId, s))
            : null;
          if (sold) {
            await logEvent(user.id, `🔄 Sin MXN ($${mxn.toFixed(2)}) → vendo ${sold} para fondear ${ins.symbol}`, 'warn');
          } else {
            await logEvent(user.id, `Sin fondos ($${mxn.toFixed(2)}) para ${ins.symbol} · el planner evaluará rotar`, 'info');
          }
          await release();
          continue;
        }
        await logEvent(user.id, `⚙ Worker: BUY ${ins.symbol} @ ${price}`, 'ok');
        // Comprar por CANTIDAD alineada al step (no por monto): así la posición queda
        // en múltiplos exactos y al venderla se vende TODA → no queda polvo.
        const stepB = lim?.stepSize ?? 0;
        const qtyBuy = floorToStep(price > 0 ? minor / price : 0, stepB);
        const useQty = stepB > 0 && qtyBuy > 0 && (!lim || (qtyBuy >= lim.minimumAmount && qtyBuy * price >= lim.minimumValue));
        const placed = useQty
          ? await client.placeOrder({ book: ins.symbol, side: 'buy', type: 'market', major: qtyStr(qtyBuy, stepB) })
          : await client.placeOrder({ book: ins.symbol, side: 'buy', type: 'market', minor: roundStr(minor, 2) });
        const buyQty = useQty ? qtyBuy : price > 0 ? minor / price : 0;
        const spent = useQty ? qtyBuy * price : minor;
        const trade = await prisma.trade.create({
          data: {
            userId: user.id, symbol: ins.symbol, side: 'BUY', amount: roundStr(spent, 4), price: String(price),
            status: 'PENDING', source: 'AI', reason: ins.reason ?? null, externalId: placed?.oid ? String(placed.oid) : null,
          },
        });
        // Niveles SIEMPRE desde el PRECIO REAL de entrada (no el que propuso la IA):
        // así el stop-loss nunca queda arriba del fill (vendía al instante por error).
        const slPctU = user.stopLossPct ? Number(user.stopLossPct) : 0;
        const tpPctU = user.takeProfitPct ? Number(user.takeProfitPct) : 0;
        const slFinal = slPctU > 0
          ? price * (1 - slPctU / 100)
          : ins.slPriceMxn ? Number(ins.slPriceMxn) : undefined;
        const tpFinal = tpPctU > 0
          ? price * (1 + tpPctU / 100)
          : ins.tpPriceMxn ? Number(ins.tpPriceMxn) : undefined;
        await applyPosition(user.id, ins.symbol, 'BUY', buyQty, price, {
          sl: slFinal,
          tp: tpFinal,
        });
        await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'EXECUTED', executedAt: new Date(), tradeId: trade.id } });
        // Descontar lo gastado para no sobre-comprar en la misma pasada.
        mxnMap.set(ins.userId, Math.max(0, mxn - spent));
        await queueNotification(user.id, 'TRADE', `BUY ${ins.symbol} (plan IA)`, `${ins.reason ?? ''} @ ${price}`);
      } else {
        // Vender: capar por el saldo REAL disponible (la posición puede ir desfasada por comisiones).
        const real = availOf(ins.userId, ins.symbol);
        const lim = limits.get(ins.symbol);
        const step = lim?.stepSize ?? 0;
        // Ajustar al stepSize del par (si no, Binance rechaza: "too much precision").
        const qty = floorToStep(Math.min(Number(ins.quantity ?? 0), real), step);
        const belowMin = lim && (qty < lim.minimumAmount || qty * price < lim.minimumValue);
        if (qty <= 0 || belowMin) {
          await logEvent(user.id, `Plan cancelado ${ins.symbol}: cantidad bajo el mínimo o sin saldo`, 'info');
          await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'CANCELLED' } });
          continue;
        }
        await logEvent(user.id, `⚙ Worker: SELL ${ins.symbol} @ ${price}`, 'ok');
        const placed = await client.placeOrder({ book: ins.symbol, side: 'sell', type: 'market', major: qtyStr(qty, step) });
        const trade = await prisma.trade.create({
          data: {
            userId: user.id, symbol: ins.symbol, side: 'SELL', amount: qtyStr(qty, step), price: String(price),
            status: 'PENDING', source: 'AI', reason: ins.reason ?? null, externalId: placed?.oid ? String(placed.oid) : null,
          },
        });
        const posRow = await prisma.position.findUnique({
          where: { userId_symbol: { userId: ins.userId, symbol: ins.symbol } },
        });
        const avgCostS = posRow ? Number(posRow.avgCostMxn) : 0;
        await applyPosition(user.id, ins.symbol, 'SELL', qty, price);
        // 🏺 Ganancia de la venta → bóveda.
        const gainS = avgCostS > 0 ? (price - avgCostS) * qty : 0;
        if (gainS > 0) {
          await saveProfitToVault(user.id, client, user, ins.symbol, gainS, (mxnMap.get(user.id) ?? 0) + price * qty);
        }
        await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'EXECUTED', executedAt: new Date(), tradeId: trade.id } });
        soldKeys.add(`${user.id}:${ins.symbol}`);
        await queueNotification(user.id, 'TRADE', `SELL ${ins.symbol} (plan IA)`, `${ins.reason ?? ''} @ ${price}`);
      }
    } catch (err) {
      await release();
      if (isAccountLimitError(err)) {
        accountBlockedUntil = Date.now() + 10 * 60_000;
        if (Date.now() - accountBlockNoticeAt > 10 * 60_000) {
          accountBlockNoticeAt = Date.now();
          await logEvent(
            user.id,
            '⛔ El exchange bloqueó la operación por límites de cuenta. Revisa tu cuenta.',
            'error',
          ).catch(() => {});
        }
      } else {
        await logEvent(user.id, `Worker error ${ins.symbol}: ${(err as Error).message.slice(0, 60)}`, 'error');
      }
    }
  }

  // Expirar instrucciones vencidas
  const expired = await prisma.instruction.findMany({ where: { status: 'PENDING', expiresAt: { lt: new Date() } } });
  for (const e of expired) {
    await prisma.instruction.update({ where: { id: e.id }, data: { status: 'EXPIRED' } });
    await logEvent(e.userId, `📋 Plan expirado · ${e.symbol}`, 'info');
  }

  // 2) Stop-Loss / Take-Profit (SIN IA)
  for (const pos of positions) {
    const user = users.find((u) => u.id === pos.userId);
    if (!user) continue;
    const slPct = user.stopLossPct ? Number(user.stopLossPct) : 0;
    const tpPct = user.takeProfitPct ? Number(user.takeProfitPct) : 0;
    const slPrice = pos.slPriceMxn ? Number(pos.slPriceMxn) : 0;
    const tpPrice = pos.tpPriceMxn ? Number(pos.tpPriceMxn) : 0;
    if (slPct <= 0 && tpPct <= 0 && slPrice <= 0 && tpPrice <= 0) {
      // Sin niveles configurados igual evaluamos "vender caro" (núcleo de la estrategia).
    }
    const price = priceMap.get(pos.symbol) ?? 0;
    if (price <= 0) continue;
    const avg = Number(pos.avgCostMxn);
    const changePct = avg > 0 ? ((price - avg) / avg) * 100 : 0;

    // ── Trailing take-profit: persigue el pico y vende si retrocede, así la
    //    ganancia que "aparece y luego se esfuma" se cobra antes de perderse.
    let peak = pos.peakPrice ? Number(pos.peakPrice) : avg;
    if (price > peak) {
      peak = price;
      await prisma.position.update({ where: { id: pos.id }, data: { peakPrice: String(peak) } }).catch(() => {});
    }
    const peakPct = avg > 0 ? ((peak - avg) / avg) * 100 : 0;
    // Trailing fino: en cuanto el pico pasa ~0.45% y retrocede ~0.15%, vende
    // (captura ganancias chicas antes de que se esfumen).
    const trailActivate = tpPct > 0 ? Math.max(0.35, tpPct * 0.45) : 0;
    const trailDist = tpPct > 0 ? Math.max(0.1, tpPct * 0.15) : 0;
    const hitTrail = tpPct > 0 && peakPct >= trailActivate && changePct <= peakPct - trailDist;

    // Prioriza los niveles por operación (los del usuario mandan sobre los de la IA).
    const hitSL = slPrice > 0 ? price <= slPrice : slPct > 0 && changePct <= -slPct;
    const hitTPfix = tpPrice > 0 ? price >= tpPrice : tpPct > 0 && changePct >= tpPct;

    // ── EVALUACIÓN de la posición: ¿VENDER o MANTENER? ────────────────
    //  1) Stop-loss, 2) Take-profit (fijo), 3) Trailing, 4) "Vender caro"
    //     (si la estadística dice que está CARA y no vamos perdiendo).
    let sellReason = '';
    if (hitSL) sellReason = `Stop-loss ${changePct.toFixed(1)}%`;
    else if (hitTPfix) sellReason = `Take-profit +${changePct.toFixed(1)}%`;
    else if (hitTrail) sellReason = `Take-profit trailing +${changePct.toFixed(2)}% (pico +${peakPct.toFixed(2)}%)`;
    else {
      try {
        const ind = await getIndicators(pos.symbol.split('_')[0]);
        // "Vender caro" SOLO si ya hay ganancia suficiente para pagar comisiones.
        // (0.2% ida+vuelta: vender en +0.0% o +0.1% es PERDER dinero.)
        if (ind && changePct >= 0.5) {
          const caro =
            ind.stat === 'CARO' || Number(ind.zScore) >= 1 || Number(ind.bbPos) >= 80 || Number(ind.rsi) >= 72;
          const barato =
            ind.stat === 'BARATO' || Number(ind.zScore) <= -1 || Number(ind.bbPos) <= 25;
          if (caro && !barato) {
            sellReason = `Vender caro (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% · z=${ind.zScore} · pos_bandas=${ind.bbPos}% · RSI=${ind.rsi})`;
          }
        }
      } catch {}
    }
    if (!sellReason) continue;

    if (soldKeys.has(`${user.id}:${pos.symbol}`)) continue; // ya se vendió en este ciclo
    const client = clients.get(user.id)!;
    // Capar por el saldo REAL (la posición puede ir desfasada por comisiones).
    const realAvail = availOf(user.id, pos.symbol);
    const limP = limits.get(pos.symbol);
    const stepP = limP?.stepSize ?? 0;
    // Ajustar al stepSize del par (si no, Binance rechaza: "too much precision").
    const qty = floorToStep(Math.min(Number(pos.baseAmount), realAvail), stepP);
    if (qty <= 0 || (limP && (qty < limP.minimumAmount || qty * price < limP.minimumValue))) {
      await logEvent(user.id, `SL/TP ${pos.symbol} no ejecutable: bajo el mínimo o sin saldo`, 'info');
      continue;
    }
    try {
      const reason = sellReason;
      await logEvent(user.id, `⚙ Worker: SELL ${pos.symbol} · ${reason}`, 'warn');
      const placed = await client.placeOrder({ book: pos.symbol, side: 'sell', type: 'market', major: qtyStr(qty, stepP) });
      const trade = await prisma.trade.create({
        data: {
          userId: user.id, symbol: pos.symbol, side: 'SELL', amount: qtyStr(qty, stepP), price: String(price),
          status: 'PENDING', source: 'AI', reason, externalId: placed?.oid ? String(placed.oid) : null,
        },
      });
      await applyPosition(user.id, pos.symbol, 'SELL', qty, price);
      // 🏺 Si la venta fue GANADORA, su ganancia se va derechito a la bóveda.
      const gainP = (price - avg) * qty;
      if (gainP > 0) {
        await saveProfitToVault(user.id, client, user, pos.symbol, gainP, (mxnMap.get(user.id) ?? 0) + price * qty);
      }
      soldKeys.add(`${user.id}:${pos.symbol}`);
      await prisma.signal.create({
        data: { userId: user.id, symbol: pos.symbol, action: 'SELL', confidence: 1, reasoning: reason, tokensUsed: 0, latencyMs: 0, executed: true },
      });
      await queueNotification(user.id, 'TRADE', `SELL ${pos.symbol} · ${reason}`, reason);
    } catch (err) {
      await logEvent(user.id, `Worker SL/TP error ${pos.symbol}: ${(err as Error).message.slice(0, 50)}`, 'error');
    }
  }
}
