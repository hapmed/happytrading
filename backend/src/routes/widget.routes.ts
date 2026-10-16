import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getLiveValuation } from '../lib/portfolio.js';
import { getRegime } from '../services/regime.js';

/**
 * Endpoint PÚBLICO para el widget de iOS (Scriptable).
 * Se autentica con el `widgetToken` único del usuario (no expone claves).
 */
export async function widgetRoutes(app: FastifyInstance) {
  app.get('/widget', async (req, reply) => {
    const token = String((req.query as any)?.token ?? '');
    if (!token) return reply.code(401).send({ error: 'token requerido' });
    const user = await prisma.user.findFirst({ where: { widgetToken: token } });
    if (!user) return reply.code(401).send({ error: 'token inválido' });

    const deps = await prisma.deposit.findMany({ where: { userId: user.id } });
    const netDeposits = deps.reduce(
      (s, d) => s + (d.kind === 'DEPOSIT' ? Number(d.amount) : -Number(d.amount)),
      0,
    );
    const invested = (user.initialCapital ? Number(user.initialCapital) : 0) + netDeposits;

    let live: any = null;
    try {
      live = await getLiveValuation(user.id);
    } catch {}
    let currentValue = live ? live.currentValue : 0;
    if (!live) {
      const last = await prisma.portfolioSnapshot.findFirst({
        where: { userId: user.id },
        orderBy: { capturedAt: 'desc' },
      });
      currentValue = last ? Number(last.totalMxn) : 0;
    }

    const pnl = invested > 0 ? currentValue - invested : 0;
    const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

    let zone = 'NEUTRAL';
    try {
      zone = (await getRegime()).zone;
    } catch {}

    const mood =
      invested > 0.01 && pnl > 0.01 ? 'profit' : invested > 0.01 && pnl < -0.01 ? 'loss' : zone === 'RISK_OFF' ? 'loss' : 'idle';

    return {
      ok: true,
      invested,
      currentValue,
      pnl,
      pnlPct,
      zone,
      mood,
      updatedAt: new Date().toISOString(),
    };
  });
}
