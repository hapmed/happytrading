import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, serializeUser } from '../lib/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { randomToken } from '../lib/crypto.js';
import { getActivity, logEvent } from '../lib/activity.js';
import { getBookLimits } from '../lib/bookLimits.js';
import { kv } from '../lib/kv.js';
import { getLiveValuation } from '../lib/portfolio.js';
import { getRegime } from '../services/regime.js';
import { getUsage, getLimits, getOpenRouterQuota } from '../lib/usage.js';
import { getIndicators } from '../lib/indicators.js';
import { makeExchangeClient, hasExchangeCreds } from '../lib/exchange.js';

// Monedas del termómetro de mercado (pares contra MXN).
const THERMO_COINS = [
  'btc', 'eth', 'xrp', 'sol', 'ltc', 'trx', 'mana', 'ada', 'doge', 'avax', 'link', 'dot', 'atom', 'uni', 'aave',
];

/**
 * Detecta saldos que NO se pueden vender (por debajo del mínimo del exchange).
 * Revisa cartera Spot + Funding y, para cada activo, si su valor alcanza el
 * mínimo de orden de su par (X_quote). Los que no, quedan "atorados".
 */
async function analyzeStuck(client: any, quote: string) {
  const [spot, funding, limits] = await Promise.all([
    Promise.resolve().then(() => client?.spotBalance?.()).catch(() => []),
    Promise.resolve().then(() => client?.fundingBalance?.()).catch(() => []),
    getBookLimits(client, 'binance').catch(() => new Map()),
  ]);
  const SKIP = new Set([quote, 'usdt', 'usdc', 'busd', 'dai', 'fdusd', 'tusd', 'usdp', 'bnb', 'mxn']);
  const acc = new Map<string, { qty: number; places: Set<string> }>();
  const add = (asset: string, free: any, place: string) => {
    const a = String(asset ?? '').toLowerCase();
    const q = Number(free ?? 0);
    if (!a || !(q > 0) || SKIP.has(a)) return;
    const cur = acc.get(a) ?? { qty: 0, places: new Set<string>() };
    cur.qty += q;
    cur.places.add(place);
    acc.set(a, cur);
  };
  for (const b of Array.isArray(spot) ? spot : []) add(b.currency, b.available, 'Spot');
  for (const b of Array.isArray(funding) ? funding : []) add(b.currency, b.available, 'Funding');

  const items: Array<{ asset: string; where: string; qty: number; value: number; sellable: boolean; reason: string }> = [];
  for (const [a, v] of acc) {
    const book = `${a}_${quote}`;
    const lim: any = (limits as Map<string, any>).get(book);
    let price = 0;
    try {
      price = Number((await client.ticker(book)).last ?? 0);
    } catch {}
    const value = v.qty * price;
    let sellable = false;
    let reason = '';
    if (!lim) reason = `sin mercado ${book.toUpperCase()}`;
    else if (!(price > 0)) reason = 'sin precio de venta';
    else if (value < Number(lim.minimumValue ?? 0)) reason = `valor ${value.toFixed(4)} < mínimo ${lim.minimumValue}`;
    else if (v.qty < Number(lim.minimumAmount ?? 0)) reason = `cantidad < mínimo ${lim.minimumAmount}`;
    else {
      sellable = true;
      reason = 'se puede vender';
    }
    items.push({ asset: a.toUpperCase(), where: [...v.places].join('+'), qty: v.qty, value, sellable, reason });
  }
  items.sort((x, y) => y.value - x.value);
  return { quote, items, stuck: items.filter((i) => !i.sellable), sellable: items.filter((i) => i.sellable) };
}


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
  // Bóveda de ganancias en moneda estable
  vaultEnabled: z.boolean().optional(),
  vaultAsset: z.enum(['usdt', 'usdc', 'dai']).optional(),
  exchange: z.enum(['bitso', 'binance']).optional(),
  quote: z.enum(['mxn', 'usdt']).optional(),
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

  // Saldo en vivo del exchange configurado
  app.get('/balance', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user || !hasExchangeCreds(user)) {
      return reply.code(400).send({ error: 'Exchange no configurado' });
    }
    try {
      const client = await makeExchangeClient(user);
      if (!client) return reply.code(400).send({ error: 'Exchange no configurado' });
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

  // Estado de la cuenta de Binance (permisos y saldos) — solo lectura.
  app.get('/exchange-status', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return reply.code(400).send({ error: 'Sesión inválida' });
    try {
      const client = await makeExchangeClient(user);
      if (!client) return reply.code(400).send({ error: 'Binance no configurado' });
      const account = await (client as any).accountStatus();
      const balances = (account?.balances ?? [])
        .filter((b: any) => Number(b.free) + Number(b.locked) > 0)
        .map((b: any) => ({ asset: b.asset, free: b.free, locked: b.locked }));
      return {
        exchange: 'binance',
        canTrade: account?.canTrade,
        canWithdraw: account?.canWithdraw,
        canDeposit: account?.canDeposit,
        permissions: account?.permissions,
        balances,
      };
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
  app.get('/positions', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const quoteCur = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    const positions = await prisma.position.findMany({
      where: { userId: req.user.sub },
      orderBy: { updatedAt: 'desc' },
    });
    const live = await getLiveValuation(req.user.sub).catch(() => null);
    const priceMap = new Map<string, number>((live?.holdings ?? []).map((h: any) => [h.currency, h.priceMxn]));
    // El costo está guardado en la moneda de cotización (USDT o MXN) → convertir a MXN.
    const quoteToMxn = quoteCur === 'mxn' ? 1 : Number(priceMap.get(quoteCur) ?? 0) || 1;
    return positions
      .filter((p) => Number(p.baseAmount) > 0)
      .map((p) => {
        const base = p.symbol.split('_')[0];
        const price = priceMap.get(base) ?? 0;
        const qty = Number(p.baseAmount);
        const avgMxn = Number(p.avgCostMxn) * quoteToMxn; // costo en MXN
        const valueMxn = qty * price;
        const pnl = avgMxn > 0 ? (price - avgMxn) * qty : 0;
        const pnlPct = avgMxn > 0 ? ((price - avgMxn) / avgMxn) * 100 : 0;
        return { symbol: p.symbol, baseAmount: qty, avgCostMxn: avgMxn, priceMxn: price, valueMxn, pnl, pnlPct };
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
      // El triggerPrice está en la moneda de cotización del par (USDT o MXN).
      const quoteCur = r.symbol.split('_')[1] ?? 'mxn';
      const liveQuote = quoteCur === 'mxn' ? 1 : Number(priceMap.get(quoteCur) ?? 0) || 0;
      const priceQuoteMxn = (priceMap.get(b) ?? 0);
      const price = liveQuote > 0 ? priceQuoteMxn / liveQuote : priceQuoteMxn; // precio en la cotización
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

  // Movimientos (depósitos/retiros) registrados (para verificar el PnL).
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
    let live: any = { withdrawals: [], error: null };
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    try {
      const client = await makeExchangeClient(user!);
      if (client) {
        const w = await client.withdrawals();
        live = { withdrawals: w, error: null };
      }
    } catch (err: any) {
      live.error = err.message;
    }
    return { recorded, netMxn, live };
  });

  // "Vaciar": vende TODAS las posiciones. Con convert:'mxn' deja el dinero en pesos;
  // con convert:'vault' lo pasa a la moneda estable.
  app.post('/vault/empty', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user || !hasExchangeCreds(user)) return reply.code(400).send({ error: 'Exchange no configurado' });
    const client = await makeExchangeClient(user);
    if (!client) return reply.code(400).send({ error: 'Exchange no configurado' });
    const exch = 'binance';
    const limits = await getBookLimits(client, exch).catch(() => new Map<string, any>());
    const body = (req.body ?? {}) as { convert?: string };
    const toMxn = (body.convert ?? 'vault').toLowerCase() === 'mxn';
    const vaultAsset = (user.vaultAsset || 'usdt').toLowerCase();
    const results: any[] = [];

    // 1) Vender todas las posiciones NO reservadas.
    const balances = await client.balance();
    const positions = await prisma.position.findMany({
      where: { userId: user.id, baseAmount: { gt: 0 }, reserved: false },
    });
    for (const p of positions) {
      try {
        const base = p.symbol.split('_')[0];
        const bal = balances.find((b: any) => String(b.currency).toLowerCase() === base);
        const qty = Math.min(Number(p.baseAmount), Number(bal?.available ?? 0) * 0.999);
        if (qty <= 0) continue;
        const t = await client.ticker(p.symbol);
        const price = Number(t.last ?? 0);
        const lim = limits.get(p.symbol);
        if (lim && (qty < lim.minimumAmount || qty * price < lim.minimumValue)) {
          results.push({ symbol: p.symbol, skipped: 'bajo el mínimo del exchange' });
          continue;
        }
        const order = await client.placeOrder({ book: p.symbol, side: 'sell', type: 'market', major: String(qty) });
        await prisma.trade.create({
          data: {
            userId: user.id, symbol: p.symbol, side: 'SELL', amount: String(qty), price: String(price),
            status: 'PENDING', source: 'AI', reason: 'Vaciar a la bóveda',
            externalId: order?.oid ? String(order.oid) : null,
          },
        });
        await prisma.position.update({ where: { id: p.id }, data: { baseAmount: '0' } });
        results.push({ symbol: p.symbol, sold: qty });
      } catch (err: any) {
        results.push({ symbol: p.symbol, error: String(err.message).slice(0, 90) });
      }
    }

    // 2) (Opcional) Comprar la moneda de la bóveda con el MXN disponible.
    await new Promise((r) => setTimeout(r, 3000));
    const bals2 = await client.balance();
    const mxn = Number(bals2.find((b: any) => String(b.currency).toLowerCase() === 'mxn')?.available ?? 0);
    const vsym = `${vaultAsset}_mxn`;
    const limV = limits.get(vsym);
    let boughtMxn = 0;
    if (!toMxn && mxn >= Math.max(1, limV?.minimumValue ?? 1)) {
      try {
        const t = await client.ticker(vsym);
        const price = Number(t.last ?? 0);
        if (price > 0) {
          const amt = Math.floor(mxn * 100) / 100;
          const order = await client.placeOrder({ book: vsym, side: 'buy', type: 'market', minor: String(amt) });
          const qty = amt / price;
          await prisma.trade.create({
            data: {
              userId: user.id, symbol: vsym, side: 'BUY', amount: String(amt), price: String(price),
              status: 'PENDING', source: 'AI', reason: 'Vaciar a la bóveda',
              externalId: order?.oid ? String(order.oid) : null,
            },
          });
          const ex = await prisma.position.findUnique({ where: { userId_symbol: { userId: user.id, symbol: vsym } } });
          const oldQty = ex ? Number(ex.baseAmount) : 0;
          const oldCost = ex ? Number(ex.avgCostMxn) : 0;
          const nQ = oldQty + qty;
          const nA = nQ > 0 ? (oldQty * oldCost + qty * price) / nQ : price;
          await prisma.position.upsert({
            where: { userId_symbol: { userId: user.id, symbol: vsym } },
            update: { baseAmount: String(nQ), avgCostMxn: String(nA), reserved: true },
            create: { userId: user.id, symbol: vsym, baseAmount: String(nQ), avgCostMxn: String(nA), reserved: true },
          });
          boughtMxn = amt;
        }
      } catch (err: any) {
        results.push({ symbol: vsym, error: String(err.message).slice(0, 90) });
      }
    }
    await logEvent(
      user.id,
      toMxn
        ? `🧺 Vaciar a MXN: ${results.length} venta(s) · quedan $${mxn.toFixed(2)} MXN`
        : `🧺 Vaciar a la bóveda: ${results.length} movimiento(s), ${vaultAsset.toUpperCase()} por ~$${boughtMxn.toFixed(2)} MXN`,
      'ok',
    ).catch(() => {});
    return { results, vaultBoughtMxn: boughtMxn, vaultAsset };
  });


  // Retiro de ganancias por SPEI a la CLABE configurada (Binance fiat withdraw).
  app.post('/payout', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return reply.code(400).send({ error: 'Sesión inválida' });
    const clabe = (user.payoutClabe ?? '').replace(/\D/g, '');
    if (clabe.length !== 18) {
      return reply.code(400).send({ error: 'Configura una CLABE de 18 dígitos en Config → Retiro de ganancias' });
    }
    if (!user.payoutBeneficiary) {
      return reply.code(400).send({ error: 'Configura el nombre del beneficiario' });
    }
    try {
      const client = await makeExchangeClient(user);
      if (!client) return reply.code(400).send({ error: 'Binance no configurado' });

      const bals = await client.balance();
      const cash = bals.find((b: any) => String(b.currency).toLowerCase() === quoteOf(user));
      const available = Number(cash?.available ?? 0);

      const body = (req.body ?? {}) as { amount?: number };
      const requested = Number(body.amount ?? 0);
      const deps = await prisma.deposit.findMany({ where: { userId: user.id } });
      const netDeposits = deps.reduce(
        (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
        0,
      );
      const invested = (user.initialCapital ? Number(user.initialCapital) : 0) + netDeposits;
      let { currentValue } = await getLiveValuation(user.id);
      const workingCapital = user.workingCapitalMxn ? Number(user.workingCapitalMxn) : invested;
      const profit = Math.max(0, currentValue - Math.max(workingCapital, invested));

      const amount = requested > 0 ? Math.min(requested, available) : Math.min(profit, available);
      if (!(amount >= 50)) {
        return reply.code(400).send({
          error: `Monto insuficiente (disponible $${available.toFixed(2)}, ganancia $${profit.toFixed(2)}; mínimo SPEI 50)`,
        });
      }
      const w = await (client as any).fiatWithdrawMxn({
        amountMxn: Math.round(amount * 100) / 100,
        clabe,
        beneficiary: user.payoutBeneficiary,
        bank: user.payoutBank ?? undefined,
      });
      await prisma.deposit.create({
        data: {
          userId: user.id,
          currency: 'mxn',
          amount: String(w?.amount ?? amount),
          kind: 'WITHDRAWAL',
          note: `binance-spei:${w?.orderId ?? w?.id ?? 'retiro'}`,
        },
      });
      return { ok: true, withdrawal: w };
    } catch (err: any) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // Bóveda: acumulado hacia los $50 + histórico total ganado/retirado.
  app.get('/vault', { preHandler: [authenticate] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const deps = await prisma.deposit.findMany({ where: { userId: req.user.sub } });
    const netDeposits = deps.reduce(
      (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
      0,
    );
    const invested = (user?.initialCapital ? Number(user.initialCapital) : 0) + netDeposits;
    let currentValue = 0;
    try {
      currentValue = (await getLiveValuation(req.user.sub))?.currentValue ?? 0;
    } catch {}
    const pnl = currentValue - invested;
    const basePnl = user?.vaultBasePnl ? Number(user.vaultBasePnl) : 0;
    const floating = Math.max(0, pnl - basePnl);

    // Bóveda REAL = lo guardado en la cartera Funding de Binance (estable, no flota).
    let vaultStored = 0;
    try {
      const client = await makeExchangeClient(user!);
      const quote = (user?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
      const f = await (client as any)?.fundingBalance?.();
      const fq = Number(f?.find((b: any) => b.currency === quote)?.available ?? 0);
      if (quote === 'mxn') {
        vaultStored = fq;
      } else {
        const t = await (client as any).ticker(`${quote}_mxn`);
        vaultStored = fq * Number(t?.last ?? 0);
      }
    } catch {}
    const vault = vaultStored; // la olla muestra lo GUARDADO (no la flotante)

    const totalWithdrawn = deps
      .filter((d) => d.kind === 'WITHDRAWAL')
      .reduce((s, d) => s + Number(d.amount), 0);
    const goal = 50;
    return {
      vault,
      vaultStored,
      floating,
      goal,
      progress: goal > 0 ? Math.min(1, vault / goal) : 0,
      totalWithdrawn,
      totalEarned: totalWithdrawn + vaultStored + floating,
      pnl,
      invested,
      currentValue,
    };
  });

  // Monedas "atoradas": saldos que NO se pueden vender (por debajo del mínimo de Binance)
  app.get('/stuck', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const quote = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    const client = await makeExchangeClient(me!);
    return analyzeStuck(client as any, quote);
  });

  // Liquidar monedas atoradas: intenta venderlas (Convert) y, si no alcanzan,
  // las convierte a BNB (dust). Sirve para recuperar lo que quedó por debajo del mínimo.
  app.post('/stuck/clean', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const quote = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    const client: any = await makeExchangeClient(me!);
    const before = await analyzeStuck(client, quote);
    const results: Array<{ asset: string; ok: boolean; via: string; detail: string }> = [];
    const dust: string[] = [];
    for (const s of before.stuck) {
      // Traer de Funding a Spot si hiciera falta (el dust se convierte desde Spot).
      if (s.where.includes('Funding')) {
        try {
          await client.transfer('FUNDING_MAIN', s.asset, s.qty);
        } catch {}
      }
      // 1) Vender por Convert (sirve si aún tiene algo de valor)
      try {
        await client.convert(s.asset, quote.toUpperCase(), Number(s.qty.toFixed(8)));
        results.push({ asset: s.asset, ok: true, via: 'convert', detail: `vendido a ${quote.toUpperCase()}` });
      } catch (e: any) {
        dust.push(s.asset);
        results.push({ asset: s.asset, ok: false, via: 'dust', detail: String(e?.message ?? 'convert falló').slice(0, 80) });
      }
    }
    if (dust.length) {
      try {
        const r = await client.dustConvert(dust);
        const n = Array.isArray(r?.transferResult) ? r.transferResult.length : 0;
        results.push({
          asset: dust.join(', '),
          ok: true,
          via: 'dust→BNB',
          detail: `${n} convertidas · comisión ${r?.totalServiceCharge ?? '?'}`,
        });
      } catch (e: any) {
        results.push({ asset: dust.join(', '), ok: false, via: 'dust→BNB', detail: String(e?.message ?? 'dust falló').slice(0, 100) });
      }
    }
    await logEvent(req.user.sub, `🧹 Barrido de monedas atoradas: ${before.stuck.length} detectadas`, 'info');
    const after = await analyzeStuck(client, quote);
    return { stuck: before.stuck, results, sellableRestante: after.sellable, stuckRestante: after.stuck };
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
