import 'dotenv/config';

const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';

// ── Secretos críticos ────────────────────────────────────────────────
// En producción son OBLIGATORIOS: si faltan, la app NO arranca (fail-fast).
// Nunca usamos un valor por defecto público, porque permitiría falsificar
// tokens JWT o descifrar las API keys de Bitso.
const jwtSecret = process.env.JWT_SECRET || (isProd ? '' : 'dev-secret-change-me');
const encryptionKey = process.env.ENCRYPTION_KEY || '';

if (isProd) {
  const missing: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    missing.push('JWT_SECRET (mínimo 32 caracteres)');
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
    missing.push('ENCRYPTION_KEY (mínimo 32 caracteres)');
  }
  if (!process.env.ADMIN_PASSWORD) {
    missing.push('ADMIN_PASSWORD');
  }
  if (missing.length) {
    throw new Error(
      `Faltan variables de entorno obligatorias: ${missing.join(', ')}. ` +
        `Defínelas en el .env antes de arrancar (no se permite ningún valor por defecto en producción).`,
    );
  }
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  env,
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://happytrading:happytrading@localhost:5432/happytrading',
  jwtSecret,
  encryptionKey,
  admin: {
    username: process.env.ADMIN_USERNAME ?? 'hapmed',
    email: process.env.ADMIN_EMAIL ?? 'admin@happytrading.app',
    password: process.env.ADMIN_PASSWORD ?? 'changeme-admin',
  },
  // Valores por defecto (luego se sobrescriben desde el panel admin)
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openrouterModel: process.env.OPENROUTER_MODEL ?? 'google/gemma-4-31b-it:free',
  execIntervalMs: Number(process.env.EXEC_INTERVAL_MS ?? 20000),
  bitsoApiBase: process.env.BITSO_API_BASE ?? 'https://bitso.com',
  botIntervalMs: Number(process.env.BOT_INTERVAL_MS ?? 300000),
  registrationToken: process.env.REGISTRATION_TOKEN ?? '',
  // Orígenes permitidos para CORS (lista separada por comas). Por defecto, mismo origen + dev local.
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY ?? '',
    secretKey: process.env.TURNSTILE_SECRET_KEY ?? '',
  },
};
