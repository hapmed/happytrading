import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  env: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://happytrading:happytrading@localhost:5432/happytrading',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  admin: {
    username: process.env.ADMIN_USERNAME ?? 'hapmed',
    email: process.env.ADMIN_EMAIL ?? 'admin@happytrading.app',
    password: process.env.ADMIN_PASSWORD ?? 'changeme-admin',
  },
  // Valores por defecto (luego se sobrescriben desde el panel admin)
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  bitsoApiBase: process.env.BITSO_API_BASE ?? 'https://bitso.com',
  botIntervalMs: Number(process.env.BOT_INTERVAL_MS ?? 300000),
  registrationToken: process.env.REGISTRATION_TOKEN ?? '',
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY ?? '',
    secretKey: process.env.TURNSTILE_SECRET_KEY ?? '',
  },
};
