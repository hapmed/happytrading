import { prisma } from '../lib/prisma.js';
import { decrypt } from '../lib/crypto.js';
import { BitsoClient } from './bitso.js';
import { queueNotification } from '../lib/notify.js';
import { logEvent } from '../lib/activity.js';

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

  const clamp = { or: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
  const [instructions, positions] = await Promise.all([
    prisma.instruction.findMany({ where: { status: 'PENDING', AND: [clamp] }, orderBy: { createdAt: 'asc' } }),
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
  const anyClient = [...clients.values()][0];

  // Precios (una vez por símbolo) — SIN IA
  const priceMap = new Map<string, number>();
  for (const sym of symbols) {
    try {
      const t = await anyClient.ticker(sym);
      priceMap.set(sym, Number(t.last ?? 0));
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

    const client = clients.get(ins.userId)!;
    try {
      if (ins.side === 'BUY') {
        const minor = Number(ins.amountMxn ?? 0);
        if (minor <= 1) {
          await prisma.instruction.update({ where: { id: ins.id }, data: { status: 'CANCELLED' } });
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
        await queueNotification(user.id, 'TRADE', `BUY ${ins.symbol} (plan IA)`, `${ins.reason ?? ''} @ ${price}`);
      } else {
        const qty = Number(ins.quantity ?? 0);
        if (qty <= 0) {
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
