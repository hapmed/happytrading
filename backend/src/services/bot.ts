import { prisma } from '../lib/prisma.js';
import { decrypt } from '../lib/crypto.js';
import { BitsoClient } from './bitso.js';
import { generateSignal } from './ai.js';
import { queueNotification } from '../lib/notify.js';
import { setState, logEvent } from '../lib/activity.js';
import { valuePortfolio } from '../lib/portfolio.js';
import { getRegime } from './regime.js';
import { fixedFractionalSize } from '../lib/sizing.js';

// Pares y umbrales por perfil de estrategia.
const SYMBOLS: Record<string, string[]> = {
  conservative: ['btc_mxn', 'eth_mxn'],
  balanced: ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn'],
  aggressive: ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn', 'ltc_mxn', 'trx_mxn', 'mana_mxn'],
};
const MIN_CONF: Record<string, number> = { conservative: 0.7, balanced: 0.6, aggressive: 0.5 };

const DEFAULT_ORDER_MXN = 200; // si no hay monto máximo configurado

function roundStr(n: number, dp: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  const s = n.toFixed(dp);
  return s.replace(/\.?0+$/, '') || '0';
}

/** Mantiene el costo promedio de la posición (para SL/TP). */
async function applyPosition(
  userId: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  qty: number,
  priceMxn: number,
): Promise<void> {
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
    const newQty = Math.max(0, Number(existing.baseAmount) - qty);
    await prisma.position.update({ where: key, data: { baseAmount: String(newQty) } });
  }
}

export async function runBotForUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.bitsoApiKey || !user.bitsoApiSecret || !user.tradingEnabled) return;

  const client = new BitsoClient({
    apiKey: decrypt(user.bitsoApiKey),
    apiSecret: decrypt(user.bitsoApiSecret),
  });

  await setState(userId, 'reading_balance', 'Leyendo saldo de Bitso');
  await logEvent(userId, 'Conexión Bitso · leyendo saldo', 'info');

  let balances: any[];
  try {
    balances = await client.balance();
  } catch (err) {
    await logEvent(userId, `Error Bitso: ${(err as Error).message}`, 'error');
    await setState(userId, 'error', 'Error de conexión Bitso');
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

  // Valoración del portafolio (equity para dimensionar por riesgo)
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

  const maxOrder = user.maxOrderAmount ? Number(user.maxOrderAmount) : DEFAULT_ORDER_MXN;
  const riskPct = user.riskPct ? Number(user.riskPct) : 1;
  const cashReservePct = user.cashReservePct != null ? Number(user.cashReservePct) : 30;
  const stopLossPct = user.stopLossPct ? Number(user.stopLossPct) : 0;
  const takeProfitPct = user.takeProfitPct ? Number(user.takeProfitPct) : 0;

  const profile = user.profile ?? 'balanced';
  const symbols = SYMBOLS[profile] ?? SYMBOLS.balanced;
  const minConf = MIN_CONF[profile] ?? 0.6;

  // Régimen de mercado (filtro de riesgo)
  const botSetting = await prisma.setting.findUnique({ where: { key: 'bot' } });
  const regimeFilter = (botSetting?.value as any)?.regimeFilter !== false;
  let regime: Awaited<ReturnType<typeof getRegime>> | null = null;
  try {
    regime = await getRegime();
  } catch {}
  if (regime) {
    await logEvent(
      userId,
      `Régimen: ${regime.zone} (${regime.score}/100)`,
      regime.zone === 'RISK_OFF' ? 'warn' : 'info',
    );
  }

  for (const symbol of symbols) {
    try {
      const ticker = await client.ticker(symbol);
      const last = Number(ticker.last ?? 0);
      const base = symbol.split('_')[0];
      const bal = balances.find((b) => String(b.currency).toLowerCase() === base);
      const baseAvailable = Number(bal?.available ?? '0');
      const key = { userId_symbol: { userId, symbol } };
      let pos = await prisma.position.findUnique({ where: key });
      // Bootstrap: si ya tienes el activo y el bot lo compró antes, reconstruye el costo.
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
            const avgCost = c / q;
            pos = await prisma.position.upsert({
              where: key,
              update: {},
              create: { userId, symbol, baseAmount: String(Math.min(baseAvailable, q)), avgCostMxn: String(avgCost) },
            });
          }
        }
      }
      const posQty = pos ? Number(pos.baseAmount) : 0;
      const avg = pos ? Number(pos.avgCostMxn) : 0;

      // 1) Salidas automáticas por Stop-Loss / Take-Profit
      if (posQty > 0 && avg > 0 && baseAvailable > 0 && last > 0) {
        const changePct = ((last - avg) / avg) * 100;
        const hitSL = stopLossPct > 0 && changePct <= -stopLossPct;
        const hitTP = takeProfitPct > 0 && changePct >= takeProfitPct;
        if (hitSL || hitTP) {
          const qty = Math.min(posQty, baseAvailable);
          const reason = hitSL ? `Stop-loss ${changePct.toFixed(1)}%` : `Take-profit +${changePct.toFixed(1)}%`;
          await prisma.signal.create({
            data: { userId, symbol, action: 'SELL', confidence: 1, reasoning: reason, tokensUsed: 0, latencyMs: 0, executed: true },
          });
          await setState(userId, 'placing_order', reason, symbol);
          await logEvent(userId, `▶ SELL ${symbol} · ${reason}`, 'ok');
          const placed = await client.placeOrder({ book: symbol, side: 'sell', type: 'market', major: roundStr(qty, 8) });
          await prisma.trade.create({
            data: {
              userId, symbol, side: 'SELL', amount: roundStr(qty, 8), price: String(ticker.last), status: 'PENDING',
              source: 'AI', reason, externalId: placed?.oid ? String(placed.oid) : null,
            },
          });
          await applyPosition(userId, symbol, 'SELL', qty, last);
          await queueNotification(userId, 'TRADE', `SELL ${symbol} · ${reason}`, `${reason}\nPrecio ${last} · costo ${avg.toFixed(2)}`);
          continue;
        }
      }

      // 2) Señal de IA (con posición)
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

      if (signal.action === 'BUY') {
        if (regimeFilter && regime && regime.zone === 'RISK_OFF') {
          await logEvent(userId, `Compra bloqueada por régimen RISK_OFF · ${symbol}`, 'warn');
          continue;
        }
        // Reserva de efectivo + dimensionado por riesgo (position-sizer)
        const reserveMxn = equityMxn * (cashReservePct / 100);
        const spendable = Math.max(0, mxnAvailable - reserveMxn);
        let size = stopLossPct > 0 ? fixedFractionalSize(equityMxn, riskPct, stopLossPct) : maxOrder;
        if (!isFinite(size) || size <= 0) size = maxOrder;
        const spend = Math.min(maxOrder, size, spendable);
        if (spend <= 1) {
          await logEvent(userId, `Sin efectivo disponible (reserva ${cashReservePct}%) · ${symbol}`, 'warn');
          continue;
        }
        const minor = roundStr(spend, 2);
        await setState(userId, 'placing_order', 'Colocando orden de compra', symbol);
        await logEvent(userId, `▶ BUY ${symbol} · $${minor} MXN`, 'ok');
        const placed = await client.placeOrder({ book: symbol, side: 'buy', type: 'market', minor });
        await prisma.trade.create({
          data: {
            userId, symbol, side: 'BUY', amount: minor, price: String(ticker.last), status: 'PENDING',
            source: 'AI', reason: signal.reasoning, externalId: placed?.oid ? String(placed.oid) : null,
          },
        });
        if (last > 0) await applyPosition(userId, symbol, 'BUY', spend / last, last);
        await queueNotification(userId, 'TRADE', `BUY ${symbol}`, `Monto $${minor} MXN\n${signal.reasoning}`);
      } else {
        // SELL por señal de IA
        const qty = Math.min(posQty > 0 ? posQty : baseAvailable, baseAvailable);
        if (qty <= 0) {
          await logEvent(userId, `Sin saldo para vender · ${symbol}`, 'warn');
          continue;
        }
        await setState(userId, 'placing_order', 'Colocando orden de venta', symbol);
        await logEvent(userId, `▶ SELL ${symbol} · ${roundStr(qty, 8)}`, 'ok');
        const placed = await client.placeOrder({ book: symbol, side: 'sell', type: 'market', major: roundStr(qty, 8) });
        await prisma.trade.create({
          data: {
            userId, symbol, side: 'SELL', amount: roundStr(qty, 8), price: String(ticker.last), status: 'PENDING',
            source: 'AI', reason: signal.reasoning, externalId: placed?.oid ? String(placed.oid) : null,
          },
        });
        await applyPosition(userId, symbol, 'SELL', qty, last);
        await queueNotification(userId, 'TRADE', `SELL ${symbol}`, `${signal.reasoning}`);
      }
    } catch (err) {
      await logEvent(userId, `Error ${symbol}: ${(err as Error).message.slice(0, 80)}`, 'error');
      console.error(`[bot] ${symbol} error usuario ${userId}:`, (err as Error).message);
    }
  }

  await setState(userId, 'idle', 'En espera');
  await logEvent(userId, 'Pasada completada', 'info');
}
