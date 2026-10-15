import { prisma } from '../lib/prisma.js';
import { decrypt } from '../lib/crypto.js';
import { BitsoClient } from './bitso.js';
import { generateSignal } from './gemini.js';
import { queueNotification } from '../lib/notify.js';

// Pares que monitorea el bot por defecto (ampliable desde configuración).
const WATCH_SYMBOLS = ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdc_mxn'];

// Umbral mínimo de confianza para operar y monto por defecto (MXN).
const CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_ORDER_MXN = 500;

function roundStr(n: number, dp: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  const s = n.toFixed(dp);
  return s.replace(/\.?0+$/, '') || '0';
}

/**
 * Ejecuta una pasada del bot para un usuario:
 * 1) balance + snapshot, 2) señal Gemini por par, 3) orden automática.
 */
export async function runBotForUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.bitsoApiKey || !user.bitsoApiSecret || !user.tradingEnabled) return;

  const client = new BitsoClient({
    apiKey: decrypt(user.bitsoApiKey),
    apiSecret: decrypt(user.bitsoApiSecret),
  });

  const balances = await client.balance();

  // Snapshot de balance (estadística / histórico de rendimiento).
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

  const mxn = balances.find((b) => String(b.currency).toLowerCase() === 'mxn');
  const mxnAvailable = Number(mxn?.available ?? '0');
  const maxOrder = user.maxOrderAmount ? Number(user.maxOrderAmount) : DEFAULT_ORDER_MXN;

  for (const symbol of WATCH_SYMBOLS) {
    try {
      const ticker = await client.ticker(symbol);

      // Contexto para Gemini (incluye señales recientes para evitar repetir operaciones).
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
        recentSignals: recentSignals.map((s) => ({
          action: s.action,
          confidence: String(s.confidence ?? '0'),
        })),
      };

      const signal = await generateSignal(symbol, ctx);

      await prisma.signal.create({
        data: {
          userId,
          symbol,
          action: signal.action,
          confidence: signal.confidence,
          reasoning: signal.reasoning,
          tokensUsed: signal.tokensUsed,
          latencyMs: signal.latencyMs,
          executed: false,
        },
      });

      // Operar solo con señal fuerte y auto-trading activo.
      if (!user.autoTrade || signal.action === 'HOLD' || signal.confidence < CONFIDENCE_THRESHOLD) {
        continue;
      }

      const order: any = { book: symbol, type: 'market' };

      if (signal.action === 'BUY') {
        const spend = Math.min(maxOrder, mxnAvailable);
        if (spend <= 1) continue;
        order.side = 'buy';
        order.minor = roundStr(spend, 2);
      } else {
        const base = symbol.split('_')[0];
        const bal = balances.find((b) => String(b.currency).toLowerCase() === base);
        const baseAvailable = Number(bal?.available ?? '0');
        const last = Number(ticker.last ?? '0');
        const wantBase = last > 0 ? maxOrder / last : 0;
        const qty = Math.min(wantBase, baseAvailable);
        if (qty <= 0 || last <= 0) continue;
        order.side = 'sell';
        order.major = roundStr(qty, 8);
      }

      const placed = await client.placeOrder(order);

      await prisma.trade.create({
        data: {
          userId,
          symbol,
          side: signal.action,
          amount: order.major ?? order.minor ?? '0',
          price: String(ticker.last ?? '0'),
          status: 'PENDING',
          source: 'AI',
          reason: signal.reasoning,
          externalId: placed?.oid ? String(placed.oid) : null,
        },
      });

      await queueNotification(
        userId,
        'TRADE',
        `Señal ${signal.action} · ${symbol}`,
        `${signal.reasoning}\nConfianza: ${(signal.confidence * 100).toFixed(0)}% · Monto: ${order.major ?? order.minor}`,
      );
    } catch (err) {
      console.error(`[bot] ${symbol} error usuario ${userId}:`, (err as Error).message);
    }
  }
}
