import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { authRoutes } from './routes/auth.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { ensureDefaults } from './lib/defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

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

  // Sirve el frontend (SPA) desde ./public si existe (modo unificado)
  try {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '';
      if (url.startsWith('/api')) return reply.code(404).send({ error: 'No encontrado' });
      return reply.sendFile('index.html');
    });
  } catch {
    app.log.warn('Sin carpeta public/ (modo dev, el frontend corre en Vite)');
  }

  await ensureDefaults();

  return app;
}
