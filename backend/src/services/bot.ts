import { prisma } from '../lib/prisma.js';
import { decrypt } from '../lib/crypto.js';
import { BitsoClient } from './bitso.js';
import { generateSignal } from './ai.js';
import { queueNotification } from '../lib/notify.js';
import { setState, logEvent } from '../lib/activity.js';
import { valuePortfolio } from '../lib/portfolio.js';
import { getRegime } from './regime.js';

// Pares que monitorea el bot por defecto.
const WATCH_SYMBOLS = ['btc_mxn', 'eth_mxn', 'xrp_mxn', 'sol_mxn', 'usdt_mxn'];

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

  // Valoración del portafolio en MXN (gráfica de ganancias)
  try {
    const val = await valuePortfolio(client, balances);
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

  // Régimen de mercado (filtro de riesgo)
  const botSetting = await prisma.setting.findUnique({ where: { key: 'bot' } });
  const regimeFilter = (botSetting?.value as any)?.regimeFilter !== false; // por defecto: activado
  let regime: Awaited<ReturnType<typeof getRegime>> | null = null;
  try {
    regime = await getRegime();
  } catch {}
  if (regime) {
    await logEvent(
      userId,
      `Régimen de mercado: ${regime.zone} (${regime.score}/100)${regime.cached ? ' · cache' : ''}`,
      regime.zone === 'RISK_OFF' ? 'warn' : 'info',
    );
  }

  for (const symbol of WATCH_SYMBOLS) {
    try {
      await setState(userId, 'ai_thinking', 'IA analizando mercado', symbol);
      await logEvent(userId, `IA analizando ${symbol}`, 'ai');

      const ticker = await client.ticker(symbol);

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

      await logEvent(
        userId,
        `${symbol} → ${signal.action} (${(signal.confidence * 100).toFixed(0)}%)`,
        signal.action === 'HOLD' ? 'info' : 'ok',
      );

      if (!user.autoTrade || signal.action === 'HOLD' || signal.confidence < CONFIDENCE_THRESHOLD) {
        continue;
      }

      const order: any = { book: symbol, type: 'market' };

      if (signal.action === 'BUY') {
        if (regimeFilter && regime && regime.zone === 'RISK_OFF') {
          await logEvent(userId, `Compra bloqueada por régimen RISK_OFF · ${symbol}`, 'warn');
          continue;
        }
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

      await setState(userId, 'placing_order', 'Colocando orden', symbol);
      await logEvent(userId, `▶ Enviando orden ${String(order.side).toUpperCase()} ${symbol}`, 'ok');

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
      await logEvent(userId, `Error ${symbol}: ${(err as Error).message.slice(0, 80)}`, 'error');
      console.error(`[bot] ${symbol} error usuario ${userId}:`, (err as Error).message);
    }
  }

  await setState(userId, 'idle', 'En espera');
  await logEvent(userId, 'Pasada completada', 'info');
}
