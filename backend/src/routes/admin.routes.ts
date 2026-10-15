import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAdmin, serializeUser } from '../lib/auth.js';
import { hashPassword } from '../lib/crypto.js';
import { sendMail } from '../lib/email.js';

const MASK = '••••••';

const smtpSchema = z.object({
  host: z.string().optional().default(''),
  port: z.number().int().min(1).optional().default(587),
  secure: z.boolean().optional().default(false),
  user: z.string().optional(),
  pass: z.string().optional(),
  from: z.string().optional(),
});

const settingsSchema = z.object({
  smtp: smtpSchema.nullable().optional(),
  gemini: z.object({ apiKey: z.string() }).nullable().optional(),
  registration_token: z.object({ value: z.string() }).nullable().optional(),
  turnstile: z.object({ siteKey: z.string(), secretKey: z.string() }).nullable().optional(),
});

function preserveMasked(old: any, incoming: any, field: string) {
  if (!incoming || !old) return incoming;
  if (incoming[field] === MASK) return { ...incoming, [field]: old[field] };
  return incoming;
}

export async function adminRoutes(app: FastifyInstance) {
  // ----- Usuarios -----
  app.get('/users', { preHandler: [requireAdmin] }, async () => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map(serializeUser);
  });

  app.post('/users', { preHandler: [requireAdmin] }, async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().optional(),
        role: z.enum(['ADMIN', 'USER']).optional(),
      })
      .parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) return reply.code(409).send({ error: 'Correo ya registrado' });
    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        passwordHash: await hashPassword(body.password),
        name: body.name,
        role: body.role ?? 'USER',
        verified: true,
      },
    });
    return serializeUser(user);
  });

  app.patch('/users/:id', { preHandler: [requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
        role: z.enum(['ADMIN', 'USER']).optional(),
        name: z.string().optional(),
      })
      .parse(req.body);
    const user = await prisma.user.update({ where: { id }, data: body });
    return serializeUser(user);
  });

  app.delete('/users/:id', { preHandler: [requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user.sub) return reply.code(400).send({ error: 'No puedes eliminarte a ti mismo' });
    await prisma.user.delete({ where: { id } });
    return { ok: true };
  });

  // ----- Configuración global -----
  app.get('/settings', { preHandler: [requireAdmin] }, async () => {
    const keys = ['smtp', 'gemini', 'registration_token', 'turnstile'];
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    const mask = (obj: any, field: string) =>
      obj && obj[field] ? { ...obj, [field]: MASK } : obj;
    if (out.smtp) out.smtp = mask(out.smtp, 'pass');
    if (out.gemini) out.gemini = mask(out.gemini, 'apiKey');
    if (out.turnstile) out.turnstile = mask(out.turnstile, 'secretKey');
    return out;
  });

  app.put('/settings', { preHandler: [requireAdmin] }, async (req) => {
    const body = settingsSchema.parse(req.body);

    const existing = await prisma.setting.findMany({
      where: { key: { in: ['smtp', 'gemini', 'registration_token', 'turnstile'] } },
    });
    const map = new Map(existing.map((r) => [r.key, r.value]));

    const upsert = async (key: string, value: unknown) => {
      if (value === undefined) return;
      if (value === null) {
        await prisma.setting.upsert({ where: { key }, update: { value: {} }, create: { key, value: {} } });
      } else {
        await prisma.setting.upsert({
          where: { key },
          update: { value: value as object },
          create: { key, value: value as object },
        });
      }
    };

    if (body.smtp !== undefined) {
      let smtp: any = body.smtp;
      if (smtp && !smtp.host) {
        // Sin host => SMTP sin configurar (permite guardar solo Gemini/anti-bots)
        smtp = {};
      } else if (smtp) {
        smtp = preserveMasked(map.get('smtp'), smtp, 'pass');
      }
      await upsert('smtp', smtp);
    }
    if (body.gemini !== undefined) {
      let gemini: any = body.gemini;
      if (gemini) gemini = preserveMasked(map.get('gemini'), gemini, 'apiKey');
      await upsert('gemini', gemini);
    }
    if (body.registration_token !== undefined) {
      await upsert('registration_token', body.registration_token);
    }
    if (body.turnstile !== undefined) {
      let turnstile: any = body.turnstile;
      if (turnstile) turnstile = preserveMasked(map.get('turnstile'), turnstile, 'secretKey');
      await upsert('turnstile', turnstile);
    }

    return { ok: true };
  });

  app.post('/settings/test-smtp', { preHandler: [requireAdmin] }, async (req, reply) => {
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    try {
      await sendMail(to, 'Prueba HappyTrading', '¡Tu configuración SMTP funciona!');
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'Error SMTP' });
    }
  });

  // ----- Estadísticas -----
  app.get('/stats', { preHandler: [requireAdmin] }, async () => {
    const [users, trades, signals, snapshots] = await Promise.all([
      prisma.user.count(),
      prisma.trade.count(),
      prisma.signal.count(),
      prisma.balanceSnapshot.count(),
    ]);
    return { users, trades, signals, snapshots };
  });
}
