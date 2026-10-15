import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { authRoutes } from './routes/auth.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { ensureDefaults } from './lib/defaults.js';

export async function buildApp() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Datos inválidos', details: error.issues });
    }
    request.log.error(error);
    const status = (error as any).statusCode ?? 500;
    reply.code(status).send({ error: error.message ?? 'Error interno' });
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.jwtSecret });

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(userRoutes, { prefix: '/api/me' });

  await ensureDefaults();

  return app;
}
