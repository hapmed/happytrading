import { buildApp } from './app.js';
import { config } from './config.js';
import { startWorker } from './worker.js';

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`HappyTrading listo en http://0.0.0.0:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Arranca los bucles del bot (planificador + ejecutor) en el mismo proceso.
startWorker();
