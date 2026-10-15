import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, serializeUser } from '../lib/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { BitsoClient } from '../services/bitso.js';
import { getActivity } from '../lib/activity.js';
import { kv } from '../lib/kv.js';
import { getLiveValuation } from '../lib/portfolio.js';
import { getRegime } from '../services/regime.js';

const bitsoSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
});

const tradingSchema = z.object({
  autoTrade: z.boolean().optional(),
  tradingEnabled: z.boolean().optional(),
  maxOrderAmount: z.number().positive().optional(),
  stopLossPct: z.number().min(0).optional(),
  takeProfitPct: z.number().min(0).optional(),
  initialCapital: z.number().min(0).optional(),
  riskPct: z.number().min(0).optional(),
  cashReservePct: z.number().min(0).max(100).optional(),
  profile: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
  symbols: z.string().max(400).optional(),
  dcaLevels: z.number().int().min(1).max(10).optional(),
  dcaStepPct: z.number().min(0).max(50).optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.get('/profile', { preHandler: [authenticate] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return { error: 'No encontrado' };
    return serializeUser(user);
  });

  app.put('/profile', { preHandler: [authenticate] }, async (req) => {
    const body = z.object({ name: z.string().optional() }).parse(req.body);
    const user = await prisma.user.update({ where: { id: req.user.sub }, data: body });
    return serializeUser(user);
  });

  // Configuración de la API de Bitso del usuario (se cifra en reposo)
  app.put('/bitso', { preHandler: [authenticate] }, async (req) => {
    const body = bitsoSchema.parse(req.body);
    await prisma.user.update({
      where: { id: req.user.sub },
      data: { bitsoApiKey: encrypt(body.apiKey), bitsoApiSecret: encrypt(body.apiSecret) },
    });
    return { ok: true };
  });

  app.delete('/bitso', { preHandler: [authenticate] }, async (req) => {
    await prisma.user.update({
      where: { id: req.user.sub },
      data: { bitsoApiKey: null, bitsoApiSecret: null },
    });
    return { ok: true };
  });

  app.put('/trading', { preHandler: [authenticate] }, async (req) => {
    const body = tradingSchema.parse(req.body);
    await prisma.user.update({ where: { id: req.user.sub }, data: body });
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    return serializeUser(user);
  });

  app.get('/trades', { preHandler: [authenticate] }, async (req) => {
    return prisma.trade.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  app.get('/signals', { preHandler: [authenticate] }, async (req) => {
    return prisma.signal.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  // Saldo en vivo desde Bitso
  app.get('/balance', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.bitsoApiKey || !user?.bitsoApiSecret) {
      return reply.code(400).send({ error: 'Bitso no conectado' });
    }
    try {
      const client = new BitsoClient({
        apiKey: decrypt(user.bitsoApiKey),
        apiSecret: decrypt(user.bitsoApiSecret),
      });
      const balances = await client.balance();
      return { balances };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Histórico de saldos (snapshots capturados por el bot)
  app.get('/snapshots', { preHandler: [authenticate] }, async (req) => {
    return prisma.balanceSnapshot.findMany({
      where: { userId: req.user.sub },
      orderBy: { capturedAt: 'desc' },
      take: 100,
    });
  });

  // Centro de actividad: estado del bot + consola en vivo
  app.get('/activity', { preHandler: [authenticate] }, async (req) => {
    return getActivity(req.user.sub);
  });

  // Régimen de mercado cripto (adaptado de crypto-regime-analyzer)
  app.get('/regime', { preHandler: [authenticate] }, async () => {
    return getRegime();
  });

  // Mis posiciones con PnL no realizado (memoria de operaciones)
  app.get('/positions', { preHandler: [authenticate] }, async (req) => {    const positions = await prisma.position.findMany({
      where: { userId: req.user.sub },
      orderBy: { updatedAt: 'desc' },
    });
    const live = await getLiveValuation(req.user.sub).catch(() => null);
    const priceMap = new Map<string, number>((live?.holdings ?? []).map((h: any) => [h.currency, h.priceMxn]));
    return positions
      .filter((p) => Number(p.baseAmount) > 0)
      .map((p) => {
        const base = p.symbol.split('_')[0];
        const price = priceMap.get(base) ?? 0;
        const qty = Number(p.baseAmount);
        const avg = Number(p.avgCostMxn);
        const valueMxn = qty * price;
        const pnl = avg > 0 ? (price - avg) * qty : 0;
        const pnlPct = avg > 0 ? ((price - avg) / avg) * 100 : 0;
        return { symbol: p.symbol, baseAmount: qty, avgCostMxn: avg, priceMxn: price, valueMxn, pnl, pnlPct };
      });
  });

  // Instrucciones/plan que la IA dejó para el worker (sin IA)
  app.get('/instructions', { preHandler: [authenticate] }, async (req) => {
    return prisma.instruction.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
  });

  // Portafolio EN VIVO: inversión inicial vs valor actual (precios al momento)
  app.get('/portfolio', { preHandler: [authenticate] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const invested = user?.initialCapital ? Number(user.initialCapital) : 0;

    let live: any = null;
    try {
      live = await getLiveValuation(req.user.sub);
    } catch {
      live = null;
    }

    const historyRows = await prisma.portfolioSnapshot.findMany({
      where: { userId: req.user.sub },
      orderBy: { capturedAt: 'asc' },
      take: 300,
    });

    const history: Array<{ t: string | Date; v: number }> = historyRows.map((h) => ({
      t: h.capturedAt,
      v: Number(h.totalMxn),
    }));
    if (live) history.push({ t: live.updatedAt, v: live.currentValue });

    const last = historyRows[historyRows.length - 1];
    const currentValue = live ? live.currentValue : last ? Number(last.totalMxn) : 0;
    const holdings = live ? live.holdings : ((last?.holdings as any) ?? []);
    const pnl = invested > 0 ? currentValue - invested : 0;
    const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

    return {
      invested,
      currentValue,
      pnl,
      pnlPct,
      holdings,
      live: !!live,
      updatedAt: live?.updatedAt ?? last?.capturedAt ?? null,
      history,
    };
  });

  // Lanza una pasada inmediata del bot para este usuario
  app.post('/run', { preHandler: [authenticate] }, async (req) => {
    await kv.lpush('bot:queue', req.user.sub);
    return { queued: true };
  });
}
