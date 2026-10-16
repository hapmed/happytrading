import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, serializeUser } from '../lib/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { randomToken } from '../lib/crypto.js';
import { BitsoClient } from '../services/bitso.js';
import { getActivity } from '../lib/activity.js';
import { kv } from '../lib/kv.js';
import { getLiveValuation } from '../lib/portfolio.js';
import { getRegime } from '../services/regime.js';
import { getUsage, getLimits, getOpenRouterQuota } from '../lib/usage.js';
import { getIndicators } from '../lib/indicators.js';

// Monedas del termómetro de mercado (pares contra MXN).
const THERMO_COINS = [
  'btc', 'eth', 'xrp', 'sol', 'ltc', 'trx', 'mana', 'ada', 'doge', 'avax', 'link', 'dot', 'atom', 'uni', 'aave',
];

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
  rotate: z.boolean().optional(),
  volatileTop: z.number().int().min(0).max(20).optional(),
  symbols: z.string().max(400).optional(),
  dcaLevels: z.number().int().min(1).max(10).optional(),
  dcaStepPct: z.number().min(0).max(50).optional(),
  // Retiro de ganancias por SPEI
  payoutEnabled: z.boolean().optional(),
  payoutClabe: z.string().max(24).optional(),
  payoutBeneficiary: z.string().max(120).optional(),
  payoutBank: z.string().max(60).optional(),
  workingCapitalMxn: z.number().min(0).optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.get('/profile', { preHandler: [authenticate] }, async (req) => {
    let user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (user && user.autoTrade && !user.autoSince) {
      user = await prisma.user.update({ where: { id: user.id }, data: { autoSince: new Date() } });
    }
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
    const current = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const data: any = { ...body };
    if (body.autoTrade === true) {
      if (!current?.autoSince) data.autoSince = new Date();
    } else if (body.autoTrade === false) {
      if (current?.autoSince) {
        const secs = Math.max(0, Math.floor((Date.now() - new Date(current.autoSince).getTime()) / 1000));
        data.autoTotalSec = (current.autoTotalSec || 0) + secs;
      }
      data.autoSince = null;
    }
    await prisma.user.update({ where: { id: req.user.sub }, data });
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

  // Termómetro de mercado: qué tan barato/caro está cada moneda (estadística).
  app.get('/market', { preHandler: [authenticate] }, async () => {
    const rows = await Promise.all(
      THERMO_COINS.map(async (c) => {
        const ind = await getIndicators(c).catch(() => null);
        return ind ? { currency: c, ...ind } : null;
      }),
    );
    const coins = rows.filter(Boolean).sort((a: any, b: any) => a.zScore - b.zScore);
    return { coins, updatedAt: new Date().toISOString() };
  });

  // Límites/estado de la cuenta de Bitso (para saber si Bitso bloquea operaciones).
  app.get('/bitso-status', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.bitsoApiKey || !user?.bitsoApiSecret) {
      return reply.code(400).send({ error: 'Bitso no conectado' });
    }
    try {
      const client = new BitsoClient({
        apiKey: decrypt(user.bitsoApiKey),
        apiSecret: decrypt(user.bitsoApiSecret),
      });
      const status = await client.accountStatus();
      // Prefijo de la API key para que el usuario identifique cuál editar en Bitso.
      const prefix = decrypt(user.bitsoApiKey).slice(0, 6);
      return { ...status, apiKeyPrefix: `${prefix}…` };
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

  // Token único para el widget de iOS (Scriptable)
  app.get('/widget-token', { preHandler: [authenticate] }, async (req) => {
    let user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.widgetToken) {
      user = await prisma.user.update({ where: { id: req.user.sub }, data: { widgetToken: randomToken(24) } });
    }
    return { token: user.widgetToken };
  });

  app.post('/widget-token/rotate', { preHandler: [authenticate] }, async (req) => {
    const user = await prisma.user.update({ where: { id: req.user.sub }, data: { widgetToken: randomToken(24) } });
    return { token: user.widgetToken };
  });

  // Consumo de IA del día (tokens/peticiones) y límites del free tier
  app.get('/usage', { preHandler: [authenticate] }, async () => {
    const or = await prisma.setting.findUnique({ where: { key: 'openrouter' } });
    const orKey = (or?.value as any)?.apiKey || '';
    const [limits, quota] = await Promise.all([getLimits(), getOpenRouterQuota(orKey)]);
    return { ...getUsage(), limits, openrouterQuota: quota };
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
    const rows = await prisma.instruction.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    const live = await getLiveValuation(req.user.sub).catch(() => null);
    const priceMap = new Map<string, number>((live?.holdings ?? []).map((h: any) => [h.currency, h.priceMxn]));
    return rows.map((r) => {
      const b = r.symbol.split('_')[0];
      const price = priceMap.get(b) ?? 0;
      const trigger = Number(r.triggerPrice);
      let distancePct = 0;
      if (price > 0 && trigger > 0) {
        if (r.trigger === 'price_below') distancePct = ((price - trigger) / price) * 100;
        else if (r.trigger === 'price_above') distancePct = ((trigger - price) / price) * 100;
      }
      return { ...r, priceMxn: price, distancePct: Math.max(0, distancePct) };
    });
  });

  // Depósitos/retiros detectados (no cuentan como ganancia)
  app.get('/deposits', { preHandler: [authenticate] }, async (req) => {
    return prisma.deposit.findMany({
      where: { userId: req.user.sub },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    });
  });

  // Registrar un depósito/retiro manualmente (p. ej. backfill)
  app.post('/deposits', { preHandler: [authenticate] }, async (req) => {
    const body = z
      .object({
        amount: z.number().positive(),
        kind: z.enum(['DEPOSIT', 'WITHDRAWAL']).optional(),
        note: z.string().max(200).optional(),
      })
      .parse(req.body);
    return prisma.deposit.create({
      data: {
        userId: req.user.sub,
        currency: 'mxn',
        amount: String(body.amount),
        kind: body.kind ?? 'DEPOSIT',
        note: body.note ?? 'registro manual',
      },
    });
  });

  // Movimientos (depósitos/retiros): los registrados + los reales de Bitso (para verificar el PnL).
  app.get('/movements', { preHandler: [authenticate] }, async (req) => {
    const recorded = await prisma.deposit.findMany({
      where: { userId: req.user.sub },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    });
    const netMxn = recorded.reduce(
      (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
      0,
    );
    let live: any = { deposits: [], withdrawals: [], error: null };
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (user?.bitsoApiKey && user?.bitsoApiSecret) {
      try {
        const client = new BitsoClient({
          apiKey: decrypt(user.bitsoApiKey),
          apiSecret: decrypt(user.bitsoApiSecret),
        });
        const [d, w] = await Promise.all([client.deposits(25), client.withdrawals(25)]);
        live = { deposits: d, withdrawals: w, error: null };
      } catch (err: any) {
        live.error = err.message;
      }
    }
    return { recorded, netMxn, live };
  });

  // Métodos de retiro de Bitso (diagnóstico, solo lectura): confirma SPEI/CLABE.
  app.get('/bitso-withdrawal-methods', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.bitsoApiKey || !user?.bitsoApiSecret) {
      return reply.code(400).send({ error: 'Bitso no conectado' });
    }
    try {
      const client = new BitsoClient({
        apiKey: decrypt(user.bitsoApiKey),
        apiSecret: decrypt(user.bitsoApiSecret),
      });
      const methods = await client.withdrawalMethods();
      // Resumen legible de los métodos relevantes (SPEI/CLABE y Bitso Transfer)
      const summary = methods.map((m: any) => ({
        method: m.method,
        name: m.name,
        network: m.network,
        protocol: m.protocol,
        required_fields: m.required_fields,
        optional_fields: m.optional_fields,
        security: (m.security?.modes ?? []).map((s: any) => ({
          type: s.type,
          from: s.from_amount,
          to: s.to_amount,
        })),
        mxn: (m.currency_configurations ?? []).find((c: any) => c.currency === 'mxn') ?? null,
      }));
      return { methods: summary };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Retiro de ganancias por SPEI a la CLABE configurada.
  app.post('/payout', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.bitsoApiKey || !user?.bitsoApiSecret) {
      return reply.code(400).send({ error: 'Bitso no conectado' });
    }
    const clabe = (user.payoutClabe ?? '').replace(/\D/g, '');
    if (clabe.length !== 18) {
      return reply.code(400).send({ error: 'Configura una CLABE de 18 dígitos en Config → Retiro de ganancias' });
    }
    if (!user.payoutBeneficiary) {
      return reply.code(400).send({ error: 'Configura el nombre del beneficiario' });
    }
    try {
      const client = new BitsoClient({
        apiKey: decrypt(user.bitsoApiKey),
        apiSecret: decrypt(user.bitsoApiSecret),
      });
      // Monto disponible en MXN
      const bals = await client.balance();
      const mxn = bals.find((b: any) => String(b.currency).toLowerCase() === 'mxn');
      const available = Number(mxn?.available ?? 0);
      const body = (req.body ?? {}) as { amount?: number };
      const requested = Number(body.amount ?? 0);

      // Ganancia = valor actual - (capital inicial + depósitos netos)
      const deps = await prisma.deposit.findMany({ where: { userId: user.id } });
      const netDeposits = deps.reduce(
        (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
        0,
      );
      const invested = (user.initialCapital ? Number(user.initialCapital) : 0) + netDeposits;

      let { currentValue } = await getLiveValuation(user.id);
      const workingCapital = user.workingCapitalMxn ? Number(user.workingCapitalMxn) : invested;
      const profit = Math.max(0, currentValue - Math.max(workingCapital, invested));

      // No se puede retirar más de lo disponible ni más que la ganancia calculada.
      const maxByProfit = Math.max(0, available);
      const amount = requested > 0 ? Math.min(requested, maxByProfit) : Math.min(profit, maxByProfit);
      if (!(amount >= 1)) {
        return reply.code(400).send({
          error: `Monto insuficiente para retirar (disponible $${available.toFixed(2)}, ganancia $${profit.toFixed(2)})`,
        });
      }
      const w = await client.createSpeiWithdrawal({
        amountMxn: Math.round(amount * 100) / 100,
        clabe,
        beneficiary: user.payoutBeneficiary,
        notes: 'Ganancias HappyTrading',
      });
      await prisma.deposit.create({
        data: {
          userId: user.id,
          currency: 'mxn',
          amount: String(w?.amount ?? amount),
          kind: 'WITHDRAWAL',
          note: `spei:${w?.wid ?? w?.origin_id ?? 'retiro'}`,
        },
      });
      return { ok: true, withdrawal: w };
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (/0202|no permission/i.test(msg)) {
        return reply.code(400).send({
          error:
            'Tu API key de Bitso no tiene permiso de RETIROS. Actívalo en Bitso → Configuración → API Keys → edita la key y habilita "Retiros" (withdrawals). Luego vuelve a guardar la key en Config → Bitso.',
        });
      }
      return reply.code(400).send({ error: msg });
    }
  });

  // Portafolio EN VIVO: inversión inicial vs valor actual (precios al momento)
  app.get('/portfolio', { preHandler: [authenticate] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const deps = await prisma.deposit.findMany({ where: { userId: req.user.sub } });
    const netDeposits = deps.reduce(
      (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
      0,
    );
    const invested = (user?.initialCapital ? Number(user.initialCapital) : 0) + netDeposits;

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
      netDeposits,
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
