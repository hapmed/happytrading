// HappyTrading Worker — ejecuta el bot en background para todos los usuarios.
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { runBotForUser } from './services/bot.js';
import { redis } from './lib/redis.js';
import { heartbeat } from './lib/activity.js';

async function tick(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { bitsoApiKey: { not: null }, bitsoApiSecret: { not: null }, tradingEnabled: true },
  });
  console.log(`[worker] Pasada: ${users.length} usuario(s) activo(s)`);
  await heartbeat();
  for (const u of users) {
    try {
      await runBotForUser(u.id);
    } catch (err) {
      console.error(`[worker] error usuario ${u.id}:`, (err as Error).message);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Intervalo configurable en caliente (settings.bot.intervalMs, mínimo 30 s). */
async function getIntervalMs(): Promise<number> {
  const s = await prisma.setting.findUnique({ where: { key: 'bot' } });
  const v = (s?.value ?? {}) as any;
  const iv = Number(v.intervalMs);
  return iv && iv >= 30_000 ? iv : config.botIntervalMs;
}

/** Atiende peticiones de ejecución inmediata ("▶ EJECUTAR AHORA"). */
async function queueLoop(): Promise<void> {
  console.log('[worker] Escuchando cola de ejecución inmediata (bot:queue)');
  while (true) {
    try {
      const res = await redis.brpop('bot:queue', 0);
      if (res && res[1]) {
        console.log(`[worker] Ejecución inmediata para ${res[1]}`);
        try {
          await runBotForUser(res[1]);
        } catch (err) {
          console.error(`[worker] error run inmediato ${res[1]}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[worker] queueLoop error:', (err as Error).message);
      await sleep(2000);
    }
  }
}

/** Bucle de programación: relee el intervalo en cada ciclo. */
async function scheduleLoop(): Promise<void> {
  console.log('[worker] Bucle de programación iniciado');
  while (true) {
    let interval = config.botIntervalMs;
    try {
      interval = await getIntervalMs();
    } catch {}
    await redis.set('bot:intervalMs', String(interval)).catch(() => {});
    await sleep(interval);
    try {
      await tick();
    } catch (err) {
      console.error('[worker] error en pasada:', (err as Error).message);
    }
  }
}

async function start(): Promise<void> {
  console.log(`[worker] HappyTrading worker arrancando. Intervalo base: ${config.botIntervalMs}ms`);
  // Fija el intervalo en Redis cuanto antes (para la barra de progreso del panel)
  try {
    await redis.set('bot:intervalMs', String(await getIntervalMs()));
  } catch {}
  for (let i = 0; i < 30; i++) {
    try {
      await tick();
      break;
    } catch (err) {
      console.log('[worker] BD no lista, reintentando...', (err as Error).message);
      await sleep(5000);
    }
  }
  queueLoop();
  scheduleLoop();
}

start();
