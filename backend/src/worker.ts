// HappyTrading Worker — ejecuta el bot en background para todos los usuarios.
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { runBotForUser } from './services/bot.js';

const INTERVAL = config.botIntervalMs;

async function tick(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { bitsoApiKey: { not: null }, bitsoApiSecret: { not: null }, tradingEnabled: true },
  });
  console.log(`[worker] Pasada: ${users.length} usuario(s) activo(s)`);
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

async function start(): Promise<void> {
  console.log(`[worker] HappyTrading worker arrancando. Intervalo: ${INTERVAL}ms`);
  // Reintenta la primera pasada mientras la API termina de crear el esquema.
  for (let i = 0; i < 30; i++) {
    try {
      await tick();
      break;
    } catch (err) {
      console.log('[worker] BD no lista, reintentando...', (err as Error).message);
      await sleep(5000);
    }
  }
  setInterval(() => {
    tick().catch((err) => console.error('[worker] error en pasada:', (err as Error).message));
  }, INTERVAL);
}

start();
