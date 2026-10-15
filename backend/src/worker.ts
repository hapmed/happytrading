// HappyTrading Worker — ejecuta el bot en background con AUTO-RECUPERACIÓN.
import { writeFileSync } from 'node:fs';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { runBotForUser } from './services/bot.js';
import { redis } from './lib/redis.js';
import { heartbeat } from './lib/activity.js';

// Conexión DEDICADA para el BRPOP bloqueante (si no, bloquea el resto de comandos).
const queueRedis = redis.duplicate();

const PASS_TIMEOUT = 180_000; // ninguna pasada puede colgarse más de 3 min
const HEARTBEAT_FILE = '/tmp/worker-heartbeat';

let running = false;
let lastPassStart = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function touchHeartbeatFile(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, String(Math.floor(Date.now() / 1000)));
  } catch {}
}

/** Intervalo configurable en caliente (settings.bot.intervalMs, mínimo 30 s). */
async function getIntervalMs(): Promise<number> {
  const s = await prisma.setting.findUnique({ where: { key: 'bot' } });
  const v = (s?.value ?? {}) as any;
  const iv = Number(v.intervalMs);
  return iv && iv >= 30_000 ? iv : config.botIntervalMs;
}

async function tick(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { bitsoApiKey: { not: null }, bitsoApiSecret: { not: null }, tradingEnabled: true },
  });
  console.log(`[worker] Pasada: ${users.length} usuario(s) activo(s)`);
  await heartbeat().catch(() => {});
  touchHeartbeatFile();
  for (const u of users) {
    try {
      await runBotForUser(u.id);
    } catch (err) {
      console.error(`[worker] error usuario ${u.id}:`, (err as Error).message);
    }
  }
}

/** Pasada protegida: evita solapamientos y acota el tiempo. */
async function safeTick(reason: string): Promise<void> {
  if (running) {
    console.log(`[worker] pasada en curso; se omite (${reason})`);
    return;
  }
  running = true;
  lastPassStart = Date.now();
  try {
    await Promise.race([
      tick(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`timeout de pasada (${PASS_TIMEOUT / 1000}s)`)), PASS_TIMEOUT),
      ),
    ]);
    console.log(`[worker] pasada completada en ${Math.round((Date.now() - lastPassStart) / 1000)}s`);
  } catch (err) {
    console.error('[worker] pasada con problema:', (err as Error).message);
  } finally {
    running = false;
    touchHeartbeatFile();
  }
}

/** Ejecución inmediata solicitada desde el panel ("▶ EJECUTAR AHORA"). */
async function queueLoop(): Promise<void> {
  console.log('[worker] Escuchando cola de ejecución inmediata (bot:queue)');
  while (true) {
    try {
      const res = await queueRedis.brpop('bot:queue', 0);
      if (res && res[1]) {
        console.log(`[worker] Ejecución inmediata para ${res[1]}`);
        try {
          await runBotForUser(res[1]);
        } catch (err) {
          console.error('[worker] error run inmediato:', (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[worker] queueLoop error:', (err as Error).message);
      await sleep(2000);
    }
  }
}

/** Programador auto-correctivo: no deriva ni se queda atrás aunque una pasada tarde. */
async function scheduler(): Promise<void> {
  console.log('[worker] Programador iniciado');
  while (true) {
    console.log('[worker] prog: leyendo intervalo...');
    let interval = config.botIntervalMs;
    try {
      interval = await getIntervalMs();
    } catch (e) {
      console.error('[worker] prog: error getIntervalMs:', (e as Error).message);
    }
    console.log('[worker] prog: intervalo =', interval);
    await redis.set('bot:intervalMs', String(interval)).catch(() => {});
    console.log('[worker] prog: redis.set ok');
    await heartbeat().catch(() => {});
    console.log('[worker] prog: heartbeat ok');
    touchHeartbeatFile();

    const elapsed = lastPassStart ? Date.now() - lastPassStart : interval;
    const wait = Math.max(5000, interval - elapsed);
    console.log(`[worker] Próxima pasada en ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    await safeTick('programada');
  }
}

/** Vigilante: si por cualquier motivo no hay pasadas, las fuerza. */
async function watchdog(): Promise<void> {
  while (true) {
    await sleep(30_000);
    let interval = config.botIntervalMs;
    try {
      interval = await getIntervalMs();
    } catch {}
    const stalledFor = Date.now() - (lastPassStart || Date.now());
    if (!running && stalledFor > interval + 180_000) {
      console.warn(`[worker] watchdog: sin pasadas hace ${Math.round(stalledFor / 1000)}s → forzando`);
      await safeTick('watchdog');
    }
  }
}

async function start(): Promise<void> {
  console.log(`[worker] HappyTrading worker arrancando. Intervalo base: ${config.botIntervalMs}ms`);
  try {
    await redis.set('bot:intervalMs', String(await getIntervalMs().catch(() => config.botIntervalMs)));
  } catch {}
  touchHeartbeatFile();

  // Arranca los bucles PRIMERO (no dependen de la pasada inicial).
  queueLoop();
  scheduler();
  watchdog();
  // Pasada inicial en segundo plano (no bloquea el programador).
  safeTick('inicial');
}

start();
