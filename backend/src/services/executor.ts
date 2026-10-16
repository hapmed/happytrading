import { prisma } from '../lib/prisma.js';
import { decrypt } from '../lib/crypto.js';
import { BitsoClient } from './bitso.js';
import { queueNotification } from '../lib/notify.js';
import { logEvent } from '../lib/activity.js';
import { getBookLimits, BookLimits } from '../lib/bookLimits.js';

function roundStr(n: number, dp: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  const s = n.toFixed(dp);
  return s.replace(/\.?0+$/, '') || '0';
}

async function applyPosition(userId: string, symbol: string, side: 'BUY' | 'SELL', qty: number, priceMxn: number): Promise<void> {
  if (qty <= 0) return;
  const key = { userId_symbol: { userId, symbol } };
  const existing = await prisma.position.findUnique({ where: key });
  if (side === 'BUY') {
    const oldQty = existing ? Number(existing.baseAmount) : 0;
    const oldCost = existing ? Number(existing.avgCostMxn) : 0;
    const newQty = oldQty + qty;
    const newAvg = newQty > 0 ? (oldQty * oldCost + qty * priceMxn) / newQty : 0;
    await prisma.position.upsert({
      where: key,
      update: { baseAmount: String(newQty), avgCostMxn: String(newAvg) },
      create: { userId, symbol, baseAmount: String(newQty), avgCostMxn: String(newAvg) },
    });
  } else if (existing) {
    await prisma.position.update({ where: key, data: { baseAmount: String(Math.max(0, Number(existing.baseAmount) - qty)) } });
  }
}

// Evita rotar demasiado seguido (máx. 1 vez por minuto por usuario)
const rotateCooldown = new Map<string, number>();

// Tras un reinicio, las instrucciones que quedaron "en proceso" se recuperan una vez.
let recoveredProcessing = false;

/**
 * Sin MXN suficiente: VENDE la posición más rentable (o la que alcance) para fondear la compra.
 * Sacrifica la posición actual para no perder una mejor oportunidad (la estrategia siempre busca ganar).
 */
async function rotateToFund(
  userId: string,
  excludeSymbol: string,
  needMxn: number,
  client: BitsoClient,
  limits: Map<string, any>,
): Promise<string | null> {
  const lastT = rotateCooldown.get(userId) ?? 0;
  if (Date.now() - lastT < 60_000) return null;

  const positions = await prisma.position.findMany({ where: { userId, baseAmount: { gt: 0 } } });
  const others = positions.filter((p) => p.symbol !== excludeSymbol);
  let best: { symbol: string; qty: number; price: number; value: number; score: number } | null = null;

  for (const p of others) {
    try {
      const t = await client.ticker(p.symbol);
      const price = Number(t.last ?? 0);
      const qty = Number(p.baseAmount);
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
    let sellQty = needMxn > 0 && price > 0 ? Math.min(best.qty, (needMxn / price) * 1.05) : best.qty;
    if (lim && (sellQty < lim.minimumAmount || sellQty * price < lim.minimumValue)) {
      if (best.qty >= lim.minimumAmount && best.qty * price >= lim.minimumValue) sellQty = best.qty;
      else return null;
    }
    const placed = await client.placeOrder({ book: best.symbol, side: 'sell', type: 'market', major: roundStr(sellQty, 8) });
    await prisma.trade.create({
      data: {
        userId, symbol: best.symbol, side: 'SELL', amount: roundStr(sellQty, 8), price: String(best.price),
        status: 'PENDING', source: 'AI', reason: 'Rotar para fondear compra', externalId: placed?.oid ? String(placed.oid) : null,
      },
    });
    await applyPosition(userId, best.symbol, 'SELL', sellQty, best.price);
    return best.symbol;
  } catch (err) {
    console.error(`[rotateToFund] venta ${best.symbol} falló:`, (err as Error).message);
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
  const users = await prisma.user.findMany({
    where: { bitsoApiKey: { not: null }, bitsoApiSecret: { not: null }, tradingEnabled: true },
  });
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
    prisma.position.findMany({ where: { baseAmount: { gt: 0 } } }),
  ]);
  if (!instructions.length && !positions.length) return;

  // Símbolos a vigilar
  const symbols = new Set<string>();
  for (const i of instructions) symbols.add(i.symbol);
  for (const p of positions) symbols.add(p.symbol);

  const clients = new Map<string, BitsoClient>();
  for (const u of users) {
    clients.set(u.id, new BitsoClient({ apiKey: decrypt(u.bitsoApiKey!), apiSecret: decrypt(u.bitsoApiSecret!) }));
  }
  const clientList = [...clients.values()];

  // Límites de libro: se prueban los clientes hasta que uno responda
  // (una key inválida no debe bloquear a TODOS los usuarios).
  let limits = new Map<string, BookLimits>();
  for (const c of clientList) {
    try {
      limits = await getBookLimits(c);
      break;
    } catch {}
  }

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

  // Saldos MXN por usuario (para no comprar sin fondos)
  const mxnMap = new Map<string, number>();
  for (const u of users) {
    try {
      const bals = await clients.get(u.id)!.balance();
      const mxn = bals.find((b: any) => String(b.currency).toLowerCase() === 'mxn');
      mxnMap.set(u.id, Number(mxn?.available ?? 0));
    } catch {}
  }

  // 1) Cumplir instrucciones
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
        if (minor <= 1 || (lim && lim.minimumValue > 0 && minor < lim.minimumValue)) {
          await logEvent(user.id, `Plan cancelado ${ins.symbol}: monto bajo el mínimo`, 'warn');
          await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'CANCELLED' } });
          continue;
        }

        // ¿Alcanza el MXN? Si no, vende una posición para fondear (rota) y reintenta el próximo ciclo.
        const mxn = mxnMap.get(ins.userId) ?? 0;
        if (minor > mxn) {
          const sold = await rotateToFund(ins.userId, ins.symbol, minor, client, limits);
          if (sold) {
            await logEvent(user.id, `🔄 Sin MXN ($${mxn.toFixed(2)}) → vendo ${sold} para fondear ${ins.symbol}`, 'warn');
          } else {
            await logEvent(user.id, `Sin MXN ($${mxn.toFixed(2)}) ni posiciones para fondear ${ins.symbol}`, 'info');
          }
          await release();
          continue;
        }
        await logEvent(user.id, `⚙ Worker: BUY ${ins.symbol} @ ${price}`, 'ok');
        const placed = await client.placeOrder({ book: ins.symbol, side: 'buy', type: 'market', minor: roundStr(minor, 2) });
        const trade = await prisma.trade.create({
          data: {
            userId: user.id, symbol: ins.symbol, side: 'BUY', amount: roundStr(minor, 2), price: String(price),
            status: 'PENDING', source: 'AI', reason: ins.reason ?? null, externalId: placed?.oid ? String(placed.oid) : null,
          },
        });
        await applyPosition(user.id, ins.symbol, 'BUY', price > 0 ? minor / price : 0, price);
        await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'EXECUTED', executedAt: new Date(), tradeId: trade.id } });
        // Descontar el MXN gastado para no sobre-comprar en la misma pasada.
        mxnMap.set(ins.userId, Math.max(0, mxn - minor));
        await queueNotification(user.id, 'TRADE', `BUY ${ins.symbol} (plan IA)`, `${ins.reason ?? ''} @ ${price}`);
      } else {
        const qty = Number(ins.quantity ?? 0);
        const lim = limits.get(ins.symbol);
        const belowMin = lim && (qty < lim.minimumAmount || qty * price < lim.minimumValue);
        if (qty <= 0 || belowMin) {
          await logEvent(user.id, `Plan cancelado ${ins.symbol}: cantidad bajo el mínimo`, 'warn');
          await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'CANCELLED' } });
          continue;
        }
        await logEvent(user.id, `⚙ Worker: SELL ${ins.symbol} @ ${price}`, 'ok');
        const placed = await client.placeOrder({ book: ins.symbol, side: 'sell', type: 'market', major: roundStr(qty, 8) });
        const trade = await prisma.trade.create({
          data: {
            userId: user.id, symbol: ins.symbol, side: 'SELL', amount: roundStr(qty, 8), price: String(price),
            status: 'PENDING', source: 'AI', reason: ins.reason ?? null, externalId: placed?.oid ? String(placed.oid) : null,
          },
        });
        await applyPosition(user.id, ins.symbol, 'SELL', qty, price);
        await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'EXECUTED', executedAt: new Date(), tradeId: trade.id } });
        await queueNotification(user.id, 'TRADE', `SELL ${ins.symbol} (plan IA)`, `${ins.reason ?? ''} @ ${price}`);
      }
    } catch (err) {
      await release();
      await logEvent(user.id, `Worker error ${ins.symbol}: ${(err as Error).message.slice(0, 60)}`, 'error');
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
    const sl = user.stopLossPct ? Number(user.stopLossPct) : 0;
    const tp = user.takeProfitPct ? Number(user.takeProfitPct) : 0;
    if (sl <= 0 && tp <= 0) continue;
    const price = priceMap.get(pos.symbol) ?? 0;
    const avg = Number(pos.avgCostMxn);
    if (price <= 0 || avg <= 0) continue;
    const changePct = ((price - avg) / avg) * 100;
    const hitSL = sl > 0 && changePct <= -sl;
    const hitTP = tp > 0 && changePct >= tp;
    if (!hitSL && !hitTP) continue;

    const client = clients.get(user.id)!;
    const qty = Number(pos.baseAmount);
    const limP = limits.get(pos.symbol);
    if (limP && (qty < limP.minimumAmount || qty * price < limP.minimumValue)) {
      await logEvent(user.id, `SL/TP ${pos.symbol} no ejecutable: bajo el mínimo`, 'warn');
      continue;
    }
    try {
      const reason = hitSL ? `Stop-loss ${changePct.toFixed(1)}%` : `Take-profit +${changePct.toFixed(1)}%`;
      await logEvent(user.id, `⚙ Worker: SELL ${pos.symbol} · ${reason}`, 'warn');
      const placed = await client.placeOrder({ book: pos.symbol, side: 'sell', type: 'market', major: roundStr(qty, 8) });
      const trade = await prisma.trade.create({
        data: {
          userId: user.id, symbol: pos.symbol, side: 'SELL', amount: roundStr(qty, 8), price: String(price),
          status: 'PENDING', source: 'AI', reason, externalId: placed?.oid ? String(placed.oid) : null,
        },
      });
      await applyPosition(user.id, pos.symbol, 'SELL', qty, price);
      await prisma.signal.create({
        data: { userId: user.id, symbol: pos.symbol, action: 'SELL', confidence: 1, reasoning: reason, tokensUsed: 0, latencyMs: 0, executed: true },
      });
      await queueNotification(user.id, 'TRADE', `SELL ${pos.symbol} · ${reason}`, reason);
    } catch (err) {
      await logEvent(user.id, `Worker SL/TP error ${pos.symbol}: ${(err as Error).message.slice(0, 50)}`, 'error');
    }
  }
}
