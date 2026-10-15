import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, serializeUser } from '../lib/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { BitsoClient } from '../services/bitso.js';

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
}
