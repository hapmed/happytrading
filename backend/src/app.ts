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
import { widgetRoutes } from './routes/widget.routes.js';
import { ensureDefaults } from './lib/defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

// Orígenes permitidos. En producción el frontend se sirve desde el mismo origen,
// así que CORS casi no se usa; en dev permitimos Vite. Se puede ampliar con CORS_ORIGINS.
const DEFAULT_ORIGINS = [
  'https://happytrading.hapmed.qzz.io',
  'http://localhost:8082',
  'http://127.0.0.1:8082',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const allowedOrigins = config.corsOrigins.length ? config.corsOrigins : DEFAULT_ORIGINS;

export async function buildApp() {
  // trustProxy: detrás del túnel de Cloudflare los IPs reales llegan en X-Forwarded-For.
  // Sin esto, el rate limit vería a todos como 127.0.0.1 (límite global compartido).
  const app = Fastify({ logger: true, trustProxy: true });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Datos inválidos', details: error.issues });
    }
    request.log.error(error);
    const status = (error as any).statusCode ?? 500;
    // Nunca filtrar mensajes internos en errores 5xx (nombres de tablas, etc.).
    const message = status >= 500 ? 'Error interno' : error.message || 'Error';
    reply.code(status).send({ error: message });
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Sin Origin (clientes nativos, widget iOS, curl) → permitir.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: false,
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.jwtSecret });

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(userRoutes, { prefix: '/api/me' });
  await app.register(widgetRoutes, { prefix: '/api' });

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
