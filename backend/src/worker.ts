// Bucles del bot (planificador + ejecutor + vigilante) — corren DENTRO del proceso de la API.
import { writeFileSync } from 'node:fs';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { runBotForUser } from './services/bot.js';
import { runExecutorAll } from './services/executor.js';
import { kv } from './lib/kv.js';
import { heartbeat } from './lib/activity.js';

const PASS_TIMEOUT = 180_000;
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
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout de pasada (${PASS_TIMEOUT / 1000}s)`)), PASS_TIMEOUT)),
    ]);
    console.log(`[worker] pasada completada en ${Math.round((Date.now() - lastPassStart) / 1000)}s`);
  } catch (err) {
    console.error('[worker] pasada con problema:', (err as Error).message);
  } finally {
    running = false;
    touchHeartbeatFile();
  }
}

/** Cola interna de ejecución inmediata ("▶ EJECUTAR AHORA"). */
async function queueLoop(): Promise<void> {
  while (true) {
    try {
      const id = await kv.rpop('bot:queue');
      if (id) {
        console.log(`[worker] Ejecución inmediata para ${id}`);
        try {
          await runBotForUser(id);
        } catch (err) {
          console.error('[worker] error run inmediato:', (err as Error).message);
        }
      } else {
        await sleep(800);
      }
    } catch (err) {
      console.error('[worker] queueLoop error:', (err as Error).message);
      await sleep(2000);
    }
  }
}

async function scheduler(): Promise<void> {
  console.log('[worker] Programador iniciado');
  while (true) {
    let interval = config.botIntervalMs;
    try {
      interval = await getIntervalMs();
    } catch {}
    await kv.set('bot:intervalMs', String(interval)).catch(() => {});
    await heartbeat().catch(() => {});
    touchHeartbeatFile();
    const elapsed = lastPassStart ? Date.now() - lastPassStart : interval;
    const wait = Math.max(5000, interval - elapsed);
    await sleep(wait);
    await safeTick('programada');
  }
}

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

async function execLoop(): Promise<void> {
  console.log(`[worker] Ejecutor (sin IA) iniciado · cada ${config.execIntervalMs}ms`);
  while (true) {
    try {
      await runExecutorAll();
    } catch (err) {
      console.error('[worker] exec error:', (err as Error).message);
    }
    await sleep(config.execIntervalMs);
  }
}

/** Arranca los bucles del bot dentro del proceso actual (llamado por el servidor). */
export function startWorker(): void {
  (async () => {
    console.log('[worker] Iniciando bucles del bot (modo unificado)');
    try {
      await kv.set('bot:intervalMs', String(await getIntervalMs().catch(() => config.botIntervalMs)));
    } catch {}
    touchHeartbeatFile();
    queueLoop();
    scheduler();
    execLoop();
    watchdog();
    safeTick('inicial');
  })();
}
