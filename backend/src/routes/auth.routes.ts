import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { serializeUser } from '../lib/auth.js';
import { config } from '../config.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  token: z.string().optional(),
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = registerSchema.parse(req.body);

    // Anti-bots: token de registro (se configura desde el panel admin o por .env)
    const rt = await prisma.setting.findUnique({ where: { key: 'registration_token' } });
    const storedToken = (rt?.value as any)?.value;
    const requiredToken = storedToken ?? config.registrationToken;
    if (requiredToken && body.token !== requiredToken) {
      return reply.code(403).send({ error: 'Token de registro inválido' });
    }

    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) return reply.code(409).send({ error: 'El correo ya está registrado' });

    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        passwordHash: await hashPassword(body.password),
        name: body.name,
      },
    });

    const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '15m' });
    const refresh = app.jwt.sign({ sub: user.id, role: user.role, type: 'refresh' }, { expiresIn: '30d' });
    return { token, refresh, user: serializeUser(user) };
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const id = body.identifier.toLowerCase();
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: id }, { username: id }] },
    });
    if (!user) return reply.code(401).send({ error: 'Credenciales inválidas' });
    if (user.status === 'DISABLED') return reply.code(403).send({ error: 'Cuenta deshabilitada' });
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: 'Credenciales inválidas' });

    const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '15m' });
    const refresh = app.jwt.sign({ sub: user.id, role: user.role, type: 'refresh' }, { expiresIn: '30d' });
    return { token, refresh, user: serializeUser(user) };
  });

  app.post('/refresh', async (req, reply) => {
    const { refresh } = z.object({ refresh: z.string().min(1) }).parse(req.body);
    try {
      const decoded = app.jwt.verify<{ sub: string; role: string; type?: string }>(refresh);
      if (decoded.type !== 'refresh') return reply.code(401).send({ error: 'Token inválido' });
      // Revalidar contra la BD: estado y rol actuales (no confiar en el token).
      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user || user.status !== 'ACTIVE') return reply.code(401).send({ error: 'Sesión inválida' });
      const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '15m' });
      return { token };
    } catch {
      return reply.code(401).send({ error: 'Token inválido' });
    }
  });
}
