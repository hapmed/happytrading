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
import { floorToStep, qtyStr } from '../lib/precision.js';
import { listEarn } from '../lib/earn.js';

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
    // Los saldos por debajo de 1 centavo son ruido: Binance ni los convierte.
    if (value < 0.01) continue;
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
      // Usamos balance() (Spot + Simple Earn + Funding) para no "perder de vista" fondos.
      let balances: Array<{ asset: string; free: string; locked: string }> = [];
      try {
        const all = await (client as any).balance();
        balances = (all ?? [])
          .filter((b: any) => Number(b.total) > 0)
          .map((b: any) => ({ asset: String(b.currency).toUpperCase(), free: String(b.available ?? 0), locked: String(b.locked ?? 0) }));
      } catch {
        balances = (account?.balances ?? [])
          .filter((b: any) => Number(b.free) + Number(b.locked) > 0)
          .map((b: any) => ({ asset: b.asset, free: b.free, locked: b.locked }));
      }
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
        const qty = Math.min(Number(p.baseAmount), Number(bal?.available ?? 0));
        if (qty <= 0) continue;
        const t = await client.ticker(p.symbol);
        const price = Number(t.last ?? 0);
        const lim = limits.get(p.symbol);
        const step = lim?.stepSize ?? 0;
        const sellQty = floorToStep(qty, step); // respeta los decimales del par
        if (lim && (sellQty < lim.minimumAmount || sellQty * price < lim.minimumValue)) {
          results.push({ symbol: p.symbol, skipped: 'bajo el mínimo del exchange' });
          continue;
        }
        const order = await client.placeOrder({ book: p.symbol, side: 'sell', type: 'market', major: qtyStr(sellQty, step) });
        await prisma.trade.create({
          data: {
            userId: user.id, symbol: p.symbol, side: 'SELL', amount: qtyStr(sellQty, step), price: String(price),
            status: 'PENDING', source: 'AI', reason: 'Vaciar a la bóveda',
            externalId: order?.oid ? String(order.oid) : null,
          },
        });
        await prisma.position.update({ where: { id: p.id }, data: { baseAmount: '0' } });
        results.push({ symbol: p.symbol, sold: sellQty });
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
        // El lote falla si UNA no cumple el mínimo → reintentamos una por una.
        for (const a of dust) {
          try {
            const r = await client.dustConvert([a]);
            results.push({ asset: a, ok: true, via: 'dust→BNB', detail: `convertida · comisión ${r?.totalServiceCharge ?? '?'}` });
          } catch (e2: any) {
            // Último recurso: convertir el polvo a BTC (a veces acepta lo que el de BNB rechaza).
            try {
              const r2 = await client.dustConvertBtc([a]);
              results.push({ asset: a, ok: true, via: 'dust→BTC', detail: `convertida · ${r2?.totalTransfered ?? 'ok'}` });
            } catch (e3: any) {
              results.push({ asset: a, ok: false, via: 'dust', detail: String(e3?.message ?? 'dust falló').slice(0, 90) });
            }
          }
        }
      }
    }
    await logEvent(req.user.sub, `🧹 Barrido de monedas atoradas: ${before.stuck.length} detectadas`, 'info');
    const after = await analyzeStuck(client, quote);
    return { stuck: before.stuck, results, sellableRestante: after.sellable, stuckRestante: after.stuck };
  });

  // Evaluación de cada moneda: ¿conviene VENDERLA o MANTENERLA?
  app.get('/review', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const quote = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    const tp = me?.takeProfitPct ? Number(me.takeProfitPct) : 0;
    const [positions, limits] = await Promise.all([
      prisma.position.findMany({ where: { userId: req.user.sub, baseAmount: { gt: 0 } } }),
      getBookLimits(client, 'binance').catch(() => new Map()),
    ]);
    const items: Array<{ symbol: string; base: string; qty: number; value: number; pnlPct: number; action: string; reason: string }> = [];
    for (const p of positions) {
      const base = p.symbol.split('_')[0];
      let price = 0;
      try {
        price = Number((await client.ticker(p.symbol)).last ?? 0);
      } catch {}
      const qty = Number(p.baseAmount);
      const value = qty * price;
      const avg = Number(p.avgCostMxn);
      const pnlPct = avg > 0 ? ((price - avg) / avg) * 100 : 0;
      const lim: any = (limits as Map<string, any>).get(p.symbol);
      const step = lim?.stepSize ?? 0;
      const sellable = !lim || (floorToStep(qty, step) >= Number(lim.minimumAmount ?? 0) && value >= Number(lim.minimumValue ?? 0));
      let action = 'MANTENER';
      let reason = '';
      if (!sellable) {
        action = 'NO_VENDIBLE';
        reason = 'bajo el mínimo del exchange (polvo): no se puede vender';
      } else {
        const ind = await getIndicators(base).catch(() => null);
        if (!ind) {
          reason = 'sin datos de mercado';
        } else {
          const caro = ind.stat === 'CARO' || Number(ind.zScore) >= 1 || Number(ind.bbPos) >= 80 || Number(ind.rsi) >= 72;
          const barato = ind.stat === 'BARATO' || Number(ind.zScore) <= -1 || Number(ind.bbPos) <= 25;
          const stats = `z=${ind.zScore} · pos_bandas=${ind.bbPos}% · RSI=${ind.rsi}`;
          if (caro && !barato && pnlPct >= -0.2) {
            action = 'VENDER';
            reason = `está CARA (${stats}) → vender ahora = ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
          } else if (barato) {
            reason = `está BARATA (${stats}) → aún puede subir, se mantiene`;
          } else {
            reason = `neutra (${stats}) → espera el take-profit${tp > 0 ? ` (+${tp}%)` : ''}`;
          }
        }
      }
      items.push({ symbol: p.symbol, base, qty, value, pnlPct, action, reason });
    }
    // Añadir el polvo atorado (no son posiciones, pero conviene saber que existe).
    try {
      const st = await analyzeStuck(client, quote);
      for (const s of st.stuck) {
        if (items.some((i) => i.base === s.asset.toLowerCase())) continue;
        items.push({
          symbol: `${s.asset.toLowerCase()}_${quote}`,
          base: s.asset.toLowerCase(),
          qty: s.qty,
          value: s.value,
          pnlPct: 0,
          action: 'DEJAR',
          reason: `no se puede vender (${s.reason}) → se deja (vale ~$${s.value.toFixed(4)})`,
        });
      }
    } catch {}
    return { items };
  });

  // ── CHISMÓGRAFO DEL BOT: explica qué está pasando, con mucho humor ──
  app.get('/drama', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const quote = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    const client: any = await makeExchangeClient(me!);
    const cards: Array<{ id: string; emoji: string; title: string; text: string; mood: string }> = [];

    let balances: any[] = [];
    try {
      balances = await client.balance();
    } catch {}
    const amountOf = (cur: string) =>
      Number(balances.find((b: any) => String(b.currency).toLowerCase() === cur)?.total ?? 0);

    const [earn, stuckRes, positions, trades, live] = await Promise.all([
      listEarn(client).catch(() => []),
      analyzeStuck(client, quote).catch(() => ({ stuck: [] as any[] })),
      prisma.position.findMany({ where: { userId: req.user.sub, baseAmount: { gt: 0 } } }),
      prisma.trade.findMany({
        where: { userId: req.user.sub, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
        orderBy: { createdAt: 'desc' },
      }),
      getLiveValuation(req.user.sub).catch(() => null),
    ]);
    const stuck: any[] = stuckRes.stuck ?? [];
    const invested = me?.initialCapital ? Number(me.initialCapital) : 0;
    const currentValue = live?.currentValue ?? 0;
    const pnlPct = invested > 0 ? ((currentValue - invested) / invested) * 100 : 0;

    // 🏖️ Fondos que Binance se llevó a Simple Earn
    if (earn.length) {
      const tot = earn.map((e) => `${e.amount} ${e.asset.toUpperCase()}`).join(', ');
      cards.push({
        id: 'earn', emoji: '🏖️', title: '¡SE FUERON DE VACACIONES!', mood: 'warn',
        text: `Binance agarró ${tot} y se los llevó a "Simple Earn" a tomar el sol. El bot ya mandó la grúa a traerlos a Spot. Interés ganado: como $0.00000003 — no alcanza ni para un chicle.`,
      });
    }

    // ✨ Polvo cósmico (no vendible)
    if (stuck.length) {
      const names = stuck.slice(0, 4).map((s) => s.asset).join(', ');
      const val = stuck.reduce((a: number, s: any) => a + Number(s.value || 0), 0);
      cards.push({
        id: 'dust', emoji: '✨', title: 'POLVO CÓSMICO', mood: 'fun',
        text: `${names} valen $${val.toFixed(6)} entre todos. Ni Binance los quiere. Son el chicle pegado debajo del asiento: existen, pero no molestan.`,
      });
    }

    // 📉 / 🚀 Cómo va la ganancia
    if (invested > 0 && Math.abs(pnlPct) >= 0.05) {
      if (pnlPct < 0) {
        cards.push({
          id: 'loss', emoji: '📉', title: 'EL MERCADO ESTÁ DE LUNES', mood: 'warn',
          text: `Vas ${pnlPct.toFixed(2)}%. No es maldición: son las comisiones (0.2% por ida y vuelta) y que las memecoins respiran fuerte. Rojo hoy, verde mañana.`,
        });
      } else {
        cards.push({
          id: 'win', emoji: '🚀', title: '¡ALGUIEN ESTÁ GANANDO!', mood: 'ok',
          text: `Vas +${pnlPct.toFixed(2)}%. El bot está chambeando. No lo interrumpas.`,
        });
      }
    }

    // 🏺 La bóveda
    let vaultMxn = 0;
    try {
      const f = await client.fundingBalance();
      const fq = Number(f?.find((b: any) => b.currency === quote)?.available ?? 0);
      vaultMxn = quote === 'mxn' ? fq : fq * Number((await client.ticker(`${quote}_mxn`))?.last ?? 0);
    } catch {}
    if (vaultMxn < 50) {
      cards.push({
        id: 'vault', emoji: '🏺', title: 'LA ALCANCÍA ESTÁ EN DIETA', mood: 'fun',
        text: `La bóveda va en $${vaultMxn.toFixed(2)} de $50. Aguanta: apenas va juntando para su primer viaje a tu CLABE.`,
      });
    }

    // 😴 Sin operar
    const lastTrade = trades[0];
    const hours = lastTrade ? (Date.now() - new Date(lastTrade.createdAt).getTime()) / 3_600_000 : 99;
    if (hours >= 3) {
      cards.push({
        id: 'sleep', emoji: '😴', title: 'EL BOT ESTÁ DE BRAZOS CRUZADOS', mood: 'fun',
        text: `Lleva ${hours.toFixed(1)} h sin operar porque nada está lo bastante barato. La paciencia también es estrategia (y no cobra comisión).`,
      });
    }

    // 🔁 Rotaciones (cambió de caballo a media carrera)
    const rot = trades.find((t) => /rotar/i.test(String(t.reason ?? '')));
    if (rot) {
      cards.push({
        id: 'rotate', emoji: '🔁', title: 'EL DJ ROTÓ', mood: 'warn',
        text: `Vendimos ${String(rot.symbol).split('_')[0].toUpperCase()} para comprar otra que pintaba mejor. Como cambiar de fila en el cine cuando no ves bien.`,
      });
    }

    // 🧾 Impuesto al ping-pong (comisiones)
    if (trades.length > 0) {
      cards.push({
        id: 'fees', emoji: '🧾', title: 'IMPUESTO AL PING-PONG', mood: 'fun',
        text: `Llevas ${trades.length} ${trades.length === 1 ? 'operación' : 'operaciones'} en 24 h. Cada compra+venta se lleva ~0.2% de peaje. El mercado cobra en cada vuelta.`,
      });
    }

    // 💤 Sin caja para operar
    if (amountOf(quote) < 1 && positions.length === 0) {
      cards.push({
        id: 'broke', emoji: '💸', title: 'CAJA VACÍA', mood: 'warn',
        text: `No hay ${quote.toUpperCase()} para operar. La IA se fue a tomar un café para no gastar tokens.`,
      });
    }

    // 🎢 Posición quietecita
    if (positions.length > 0) {
      const pname = String(positions[0].symbol).split('_')[0].toUpperCase();
      cards.push({
        id: 'ride', emoji: '🎢', title: 'MONTAÑA RUSA EMOCIONAL', mood: 'fun',
        text: `${pname} sube, baja, sube... y tú mirando la pantalla. El bot espera su momento (TP/salida). Respira.`,
      });
    }

    // Si no hay nada interesante, un clásico
    if (!cards.length) {
      cards.push({
        id: 'chill', emoji: '🛸', title: 'TODO TRANQUILO', mood: 'ok',
        text: 'Nada raro que reportar. El bot está en modo acecho esperando gangas.',
      });
    }

    return { cards };
  });

  // DIAGNÓSTICO: revisa TODAS las carteras para cuadrar con la app de Binance.
  app.get('/wallets', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const out: Record<string, any> = {};
    const tryOne = async (name: string, method: any, path: string, params: any = {}, host?: string) => {
      try {
        out[name] = await client.raw(method, path, params, true, host);
      } catch (e: any) {
        out[name] = { error: String(e?.message ?? e).slice(0, 150) };
      }
    };
    await tryOne('spot', 'GET', '/api/v3/account');
    await tryOne('funding', 'POST', '/sapi/v1/asset/get-funding-asset');
    await tryOne('earnFlexible', 'GET', '/sapi/v1/simple-earn/flexible/position', { size: 100 });
    await tryOne('earnLocked', 'GET', '/sapi/v1/simple-earn/locked/position', { size: 100 });
    await tryOne('margin', 'GET', '/sapi/v1/margin/account');
    await tryOne('futures', 'GET', '/fapi/v2/balance', {}, 'https://fapi.binance.com');
    await tryOne('futuresPos', 'GET', '/fapi/v2/positionRisk', {}, 'https://fapi.binance.com');
    const nz = (arr: any[], f: (x: any) => number) => (arr ?? []).filter((x) => f(x) > 0);
    return {
      resumen: {
        spot: nz(out.spot?.balances ?? [], (b) => Number(b.free) + Number(b.locked)).map((b: any) => ({ a: b.asset, free: b.free, locked: b.locked })),
        funding: nz(Array.isArray(out.funding) ? out.funding : [], (b) => Number(b.free)).map((b: any) => ({ a: b.asset, free: b.free, frozen: b.freeze })),
        earnFlexible: (out.earnFlexible?.rows ?? []).map((b: any) => ({ a: b.asset, amt: b.totalAmount })),
        earnLocked: (out.earnLocked?.rows ?? []).map((b: any) => ({ a: b.asset, amt: b.amount })),
        futures: nz(Array.isArray(out.futures) ? out.futures : [], (b) => Number(b.balance)).map((b: any) => ({ a: b.asset, bal: b.balance, disponible: b.availableBalance, transferible: b.maxWithdrawAmount })),
        futuresAbiertas: (Array.isArray(out.futuresPos) ? out.futuresPos : [])
          .filter((p: any) => Number(p.positionAmt ?? 0) !== 0)
          .map((p: any) => ({ symbol: p.symbol, amt: p.positionAmt, entry: p.entryPrice, pnl: p.unRealizedProfit, lev: p.leverage })),
        margin: out.margin?.error ? { error: out.margin.error } : 'ok',
        earnLockedErr: out.earnLocked?.error ?? null,
      },
    };
  });

  // Cerrar TODAS las posiciones abiertas de Futuros y traer el dinero a la bolsa (Spot).
  app.post('/futures/close', { preHandler: [authenticate] }, async (req, reply) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const closed: any[] = [];
    try {
      const pos = await client.raw('GET', '/fapi/v2/positionRisk', {}, true, 'https://fapi.binance.com');
      for (const p of Array.isArray(pos) ? pos : []) {
        const amt = Number(p.positionAmt ?? 0);
        if (!amt) continue;
        const side = amt > 0 ? 'SELL' : 'BUY'; // cerrar un largo = vender
        const qty = Math.abs(amt);
        try {
          const o = await client.raw(
            'POST',
            '/fapi/v1/order',
            { symbol: p.symbol, side, type: 'MARKET', quantity: String(qty), reduceOnly: 'true' },
            true,
            'https://fapi.binance.com',
          );
          closed.push({ symbol: p.symbol, side, qty, ok: true, orderId: o?.orderId ?? null });
          await logEvent(req.user.sub, `🔒 Cerré la posición de Futuros ${p.symbol} (${qty})`, 'ok');
        } catch (e: any) {
          closed.push({ symbol: p.symbol, side, qty, ok: false, error: String(e?.message ?? e).slice(0, 120) });
        }
      }
      // Traer a Spot lo transferible
      await new Promise((r) => setTimeout(r, 3000));
      const bal = await client.raw('GET', '/fapi/v2/balance', {}, true, 'https://fapi.binance.com');
      const usdt = (Array.isArray(bal) ? bal : []).find((b: any) => String(b.asset).toUpperCase() === 'USDT');
      const can = Number(usdt?.maxWithdrawAmount ?? 0);
      let transferred = 0;
      if (can > 0.1) {
        await client.transfer('UMFUTURE_MAIN', 'USDT', Number((can * 0.999).toFixed(6)));
        transferred = can;
        await logEvent(req.user.sub, `💼 Traje ${can.toFixed(4)} USDT de Futuros → a la bolsa de Spot`, 'ok');
      }
      return { closed, transferred };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message ?? e).slice(0, 150) });
    }
  });

  // Devolver a la bolsa (Spot) lo que esté guardado en la bóveda (Funding).
  app.post('/vault/return', { preHandler: [authenticate] }, async (req, reply) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const quote = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    try {
      const f = await client.fundingBalance();
      const amt = Number(f?.find((b: any) => b.currency === quote)?.available ?? 0);
      if (amt > 0.01) {
        await client.transfer('FUNDING_MAIN', quote.toUpperCase(), Number(amt.toFixed(6)));
        await logEvent(req.user.sub, `↩️ Regresé ${amt.toFixed(4)} ${quote.toUpperCase()} de la bóveda a la bolsa de trabajo`, 'ok');
      }
      return { devuelto: amt };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message ?? e).slice(0, 150) });
    }
  });

  // ── EL BOT EXPLICA (en simple) por qué hizo lo que hizo ─────────────
  app.get('/explain', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const quote = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    const tp = me?.takeProfitPct ? Number(me.takeProfitPct) : 1;
    const sl = me?.stopLossPct ? Number(me.stopLossPct) : 0.8;

    const [positions, trades] = await Promise.all([
      prisma.position.findMany({ where: { userId: req.user.sub, baseAmount: { gt: 0 } } }),
      prisma.trade.findMany({ where: { userId: req.user.sub }, orderBy: { createdAt: 'desc' }, take: 8 }),
    ]);

    const out: string[] = [];
    const nice = (s: string) => String(s).split('_')[0].toUpperCase();

    // 1) Lo que tengo ahora y por qué (solo posiciones de verdad, no polvo)
    for (const p of positions) {
      if (out.length >= 2) break;
      const base = nice(p.symbol);
      let price = 0;
      let ind: any = null;
      try {
        price = Number((await client.ticker(p.symbol)).last ?? 0);
        ind = await getIndicators(p.symbol.split('_')[0]);
      } catch {}
      // Si vale menos de $1 USD es polvo: no vale la pena explicarlo.
      if (!(Number(p.baseAmount) * price >= 1)) continue;
      const avg = Number(p.avgCostMxn);
      const pnl = avg > 0 && price > 0 ? ((price - avg) / avg) * 100 : 0;
      const porQue = ind
        ? `la vi barata (z=${ind.zScore}, RSI=${ind.rsi})`
        : 'la vi barata';
      out.push(
        `Compré ${base} porque ${porQue} y creo que puede subir dentro de la próxima hora. ` +
          `Ahorita va ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%; el bot la venderá sola al +${tp.toFixed(1)}% ` +
          `(o antes si sube y empieza a caer), y la corta si baja −${sl.toFixed(1)}%.`,
      );
    }

    // 2) Si acabo de cerrar algo, por qué
    if (!out.length && trades.length) {
      const t = trades.find((x) => !/rotar/i.test(String(x.reason ?? ''))) ?? trades[0];
      const base = nice(t.symbol);
      const motivo = String(t.reason ?? '');
      const gano = /take-profit/i.test(motivo);
      const perdio = /stop-loss/i.test(motivo);
      const vendio = t.side === 'SELL';
      if (vendio && gano) {
        out.push(`Vendí ${base} porque ya había subido lo suficiente y preferí asegurar la ganancia antes de que se esfumara. Esa ganancia ya está guardada en la bóveda.`);
      } else if (vendio && perdio) {
        out.push(`Vendí ${base} para cortar la pérdida: el precio se cayó y no quise dejar que siguiera bajando. Mejor perder poquito que mucho.`);
      } else if (t.side === 'BUY') {
        out.push(`Compré ${base} porque la vi barata y creo que sube pronto; ya tiene su orden de venta lista.`);
      }
    }

    // 3) Si no hay nada en juego
    if (!out.length) {
      out.push(
        `Ahora mismo no tengo nada comprado: estoy buscando una moneda barata (con z muy negativo y RSI bajo) para entrar y salir rápido con ganancia. ` +
          `En cuanto alguna se ponga en ganga, compro y le dejo su orden de venta al worker (que vigila cada 8 segundos).`,
      );
    }

    return { text: out.join(' ') };
  });

  // ── ¿CUÁNDO VENDE O COMPRA? Estimación con la velocidad reciente del precio ──
  app.get('/forecast', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const nice = (s: string) => String(s).split('_')[0].toUpperCase();

    const [positions, plan] = await Promise.all([
      prisma.position.findMany({ where: { userId: req.user.sub, baseAmount: { gt: 0 } } }),
      prisma.instruction.findMany({ where: { userId: req.user.sub, status: 'PENDING' } }),
    ]);

    const items: any[] = [];

    // 1) Lo que YA tenemos: cuándo vendería (TP) y cuándo cortaría (SL)
    for (const p of positions) {
      let price = 0;
      let ind: any = null;
      try {
        price = Number((await client.ticker(p.symbol)).last ?? 0);
        ind = await getIndicators(p.symbol.split('_')[0]);
      } catch {}
      if (!(Number(p.baseAmount) * price >= 1)) continue; // polvo fuera
      const cost = Number(p.avgCostMxn);
      const tp = p.tpPriceMxn ? Number(p.tpPriceMxn) : 0;
      const sl = p.slPriceMxn ? Number(p.slPriceMxn) : 0;
      const distTp = tp > 0 && price > 0 ? ((tp - price) / price) * 100 : 0;
      const distSl = sl > 0 && price > 0 ? ((price - sl) / price) * 100 : 0;
      const mom = Number(ind?.momentumPct ?? 0);
      const atr = Number(ind?.atrPct ?? 0);
      // Velocidad estimada (%/hora): el momentum de la última hora; si es plano, la volatilidad (ATR).
      const speed = Math.max(0.05, Math.abs(mom) > 0.05 ? Math.abs(mom) : atr * Math.sqrt(12));
      const eta = (d: number) => (d > 0 ? Math.round((d / speed) * 60) : 0);
      items.push({
        kind: 'POS',
        symbol: p.symbol,
        base: nice(p.symbol),
        price,
        cost,
        tp,
        sl,
        distTp,
        distSl,
        pnlPct: cost > 0 ? ((price - cost) / cost) * 100 : 0,
        valor: Number(p.baseAmount) * price,
        etaTpMin: eta(distTp),
        etaSlMin: eta(distSl),
        speed,
        momentum: mom,
        aFavor: mom >= 0,
      });
    }

    // 2) Lo que la IA planea: compras/ventas con su condición y su tiempo de validez
    for (const i of plan) {
      let price = 0;
      try {
        price = Number((await client.ticker(i.symbol)).last ?? 0);
      } catch {}
      const trg = Number(i.triggerPrice);
      const dist = price > 0 && trg > 0 ? ((i.trigger === 'price_below' ? price - trg : trg - price) / price) * 100 : 0;
      const mins = i.expiresAt ? Math.max(0, Math.round((new Date(i.expiresAt).getTime() - Date.now()) / 60000)) : null;
      items.push({
        kind: 'PLAN',
        symbol: i.symbol,
        base: nice(i.symbol),
        side: i.side,
        trigger: i.trigger,
        triggerPrice: trg,
        price,
        dist,
        monto: i.amountMxn ? Number(i.amountMxn) : null,
        cantidad: i.quantity ? Number(i.quantity) : null,
        expiresInMin: mins,
      });
    }

    return { items };
  });

  // Guardar un monto en la BÓVEDA (Spot → Funding). Sirve para pasar ganancias ya realizadas.
  app.post('/vault/store', { preHandler: [authenticate] }, async (req, reply) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const quote = (me?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
    const amount = Math.round(Number((req.body as any)?.amount ?? 0) * 100) / 100;
    if (!(amount > 0.01)) return reply.code(400).send({ error: 'monto inválido' });
    try {
      const bal = await client.spotBalance();
      const free = Number(bal?.find((b: any) => b.currency === quote)?.available ?? 0);
      if (free < amount) return reply.code(400).send({ error: `no hay suficiente ${quote.toUpperCase()} (${free.toFixed(2)})` });
      await client.transfer('MAIN_FUNDING', quote.toUpperCase(), amount);
      await logEvent(req.user.sub, `🏺 Guardé ${amount.toFixed(2)} ${quote.toUpperCase()} de ganancia en la bóveda — ya no se mueve`, 'ok');
      return { guardado: amount };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message ?? e).slice(0, 150) });
    }
  });

  // Historial de transferencias internas (Spot ↔ Funding ↔ Futuros).
  app.get('/transfers', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const now = Date.now();
    const start = now - 30 * 86400000; // últimos 30 días
    const out: any[] = [];
    for (const t of ['MAIN_FUNDING', 'FUNDING_MAIN', 'MAIN_UMFUTURE', 'UMFUTURE_MAIN']) {
      try {
        const r = await client.raw('GET', '/sapi/v1/asset/transfer', { type: t, startTime: start, endTime: now, size: 20 }, true);
        for (const row of (r?.rows ?? [])) out.push({ type: t, asset: row.asset, amount: row.amount, status: row.status, t: row.timestamp });
      } catch (e: any) {
        // ignorar los que no existan
      }
    }
    out.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
    return { rows: out.slice(0, 40) };
  });

  // Retiro manual a la CLABE (SPEI): convierte USDT→MXN y retira por SPEI.
  app.post('/payout/manual', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return reply.code(400).send({ error: 'Sesión inválida' });
    const clabe = (user.payoutClabe ?? '').replace(/\D/g, '');
    if (clabe.length !== 18) return reply.code(400).send({ error: 'CLABE de 18 dígitos requerida' });
    if (!user.payoutBeneficiary) return reply.code(400).send({ error: 'Falta el nombre del beneficiario' });
    const body = (req.body ?? {}) as { amount?: number };
    const amountMxn = Math.round(Number(body.amount ?? 50) * 100) / 100;
    if (!(amountMxn >= 50)) return reply.code(400).send({ error: 'Mínimo 50 MXN' });
    try {
      const client: any = await makeExchangeClient(user);
      if (!client) return reply.code(400).send({ error: 'Binance no configurado' });
      const quote = (user.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';

      // 0) Si ya hay MXN en Spot (≥50), intenta retirar directo.
      try {
        const sp0 = await client.spotBalance();
        const mxnAvail = Number(sp0?.find((b: any) => b.currency === 'mxn')?.available ?? 0);
        if (mxnAvail >= amountMxn) {
          const w = await client.fiatWithdrawMxn({
            amountMxn,
            clabe,
            beneficiary: user.payoutBeneficiary,
            bank: user.payoutBank ?? undefined,
          });
          await prisma.deposit.create({
            data: { userId: user.id, currency: 'mxn', amount: String(amountMxn), kind: 'WITHDRAWAL', note: `binance-spei-manual:${w?.orderId ?? w?.id ?? 'retiro'}` },
          });
          await logEvent(user.id, `🏦 Retiro manual a tu CLABE: $${amountMxn.toFixed(2)} MXN`, 'ok');
          return { ok: true, amountMxn, withdrawal: w };
        }
      } catch {}

      // 1) El retiro SPEI parece sacar de Funding: transfiere 50 MXN Spot -> Funding.
      let movedToFunding = false;
      try {
        await client.transfer('MAIN_FUNDING', 'MXN', amountMxn);
        movedToFunding = true;
        await new Promise((r) => setTimeout(r, 2000));
      } catch {}
      // 2) Retirar MXN por SPEI a la CLABE
      try {
        const w = await client.fiatWithdrawMxn({
          amountMxn,
          clabe,
          beneficiary: user.payoutBeneficiary,
          bank: user.payoutBank ?? undefined,
        });
        await prisma.deposit.create({
          data: { userId: user.id, currency: 'mxn', amount: String(amountMxn), kind: 'WITHDRAWAL', note: `binance-spei-manual:${w?.orderId ?? w?.id ?? 'retiro'}` },
        });
        await logEvent(user.id, `🏦 Retiro manual a tu CLABE: $${amountMxn.toFixed(2)} MXN`, 'ok');
        // Limpiar: regresar lo que sobró Funding -> Spot
        try {
          const f = await client.fundingBalance();
          const fq = Number(f?.find((b: any) => b.currency === 'mxn')?.available ?? 0);
          if (fq > 0.01) await client.transfer('FUNDING_MAIN', 'MXN', Number(fq.toFixed(2)));
        } catch {}
        return { ok: true, amountMxn, withdrawal: w };
      } catch (e: any) {
        // Limpiar: regresar 50 MXN Funding -> Spot
        try { await client.transfer('FUNDING_MAIN', 'MXN', amountMxn); } catch {}
        return reply.code(400).send({ error: String(e?.message ?? e).slice(0, 250) });
      }
  });

  // Diagnóstico: prueba varias formas de aceptar la conversión USDT → MXN.
  app.post('/convert-accept-test', { preHandler: [authenticate] }, async (req) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(me!);
    const body = (req.body ?? {}) as { amount?: number };
    const amt = Number(body.amount ?? 3);
    const out: any[] = [];
    let q: any = null;
    try {
      q = await client.raw('POST', '/sapi/v1/convert/getQuote', { fromAsset: 'USDT', toAsset: 'MXN', fromAmount: String(amt) }, true);
    } catch (e: any) {
      return { tried: amt, getQuoteError: String(e?.message ?? e).slice(0, 200) };
    }
    out.push({ step: 'getQuote', response: q });
    const cands = [q.quoteId, q.validTimestamp, String(q.validTimestamp), q.orderId].filter(Boolean);
    const seen = new Set();
    for (const c of cands) {
      if (seen.has(c)) continue;
      seen.add(c);
      try {
        const a = await client.raw('POST', '/sapi/v1/convert/acceptQuote', { quoteId: c }, true);
        out.push({ step: 'acceptQuote', quoteId: c, response: a });
        break;
      } catch (e: any) {
        out.push({ step: 'acceptQuote', quoteId: c, error: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return { tried: amt, out };
  });

  // Diagnóstico: prueba el retiro SPEI con varias variantes (para encontrar el que funciona).
  app.post('/payout-debug', { preHandler: [authenticate] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const client: any = await makeExchangeClient(user!);
    const clabe = (user!.payoutClabe ?? '').replace(/\D/g, '');
    const results: any[] = [];
    const tryCall = async (name: string, fn: () => Promise<any>) => {
      try {
        results.push({ name, ok: true, result: await fn() });
      } catch (e: any) {
        results.push({ name, ok: false, error: String(e?.message ?? e).slice(0, 250) });
      }
    };

    // 1) Métodos de pago disponibles para MXN (retiro)
    await tryCall('payment-methods', async () => {
      return await client.raw('GET', '/sapi/v1/fiatpayment/query/payment-methods', { currency: 'MXN', transactionType: 1 }, true);
    });

    // 2) Retirar sin bank
    await tryCall('withdraw-no-bank', async () => {
      return await client.fiatWithdrawMxn({ amountMxn: 50, clabe, beneficiary: user!.payoutBeneficiary });
    });

    // 3) Retirar con bank
    await tryCall('withdraw-with-bank', async () => {
      return await client.fiatWithdrawMxn({ amountMxn: 50, clabe, beneficiary: user!.payoutBeneficiary, bank: user!.payoutBank });
    });

    // 4) Transferir 50 MXN Spot -> Funding, luego retirar
    await tryCall('transfer-spot-to-funding', async () => {
      await client.transfer('MAIN_FUNDING', 'MXN', 50);
      return 'ok';
    });
    await new Promise((r) => setTimeout(r, 2000));
    await tryCall('withdraw-after-transfer', async () => {
      return await client.fiatWithdrawMxn({ amountMxn: 50, clabe, beneficiary: user!.payoutBeneficiary });
    });
    // 5) Limpiar: regresar 50 MXN Funding -> Spot
    await tryCall('transfer-back', async () => {
      await client.transfer('FUNDING_MAIN', 'MXN', 50);
      return 'ok';
    });

    return { results };
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

    // 🏺 La bóveda va APARTE: es dinero ya guardado, no el que está operando.
    let vault = 0;
    try {
      const client: any = await makeExchangeClient(user!);
      const quote = (user?.quote ?? 'mxn').toLowerCase() === 'usdt' ? 'usdt' : 'mxn';
      const f = await client?.fundingBalance?.();
      const fq = Number(f?.find((b: any) => b.currency === quote)?.available ?? 0);
      vault = quote === 'mxn' ? fq : fq * Number((await client?.ticker(`${quote}_mxn`))?.last ?? 0);
    } catch {}

    const holdings = live ? live.holdings : ((last?.holdings as any) ?? []);
    const totalValue = currentValue + vault; // dinero que se mueve + lo apartado
    const pnl = invested > 0 ? totalValue - invested : 0;
    const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;
    if (history.length) history[history.length - 1] = { t: history[history.length - 1].t, v: totalValue };
    else history.push({ t: live?.updatedAt ?? new Date().toISOString(), v: totalValue });

    return {
      invested,
      netDeposits,
      currentValue, // solo lo que está operando (SIN bóveda)
      vault, // 🏺 apartado
      totalValue, // operando + bóveda
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
