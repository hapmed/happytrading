import { redis } from './redis.js';
import { config } from '../config.js';

export type BotState =
  | 'idle'
  | 'reading_balance'
  | 'ai_thinking'
  | 'placing_order'
  | 'done'
  | 'error';

export type LogLevel = 'info' | 'ai' | 'ok' | 'warn' | 'error';

const LOG_MAX = 40;
const STATE_TTL = 3600;

/** Estado actual del bot para un usuario (se ve en el Centro de Actividad). */
export async function setState(
  userId: string,
  state: BotState,
  message: string,
  symbol?: string,
): Promise<void> {
  const payload = JSON.stringify({
    state,
    message,
    symbol: symbol ?? null,
    updatedAt: new Date().toISOString(),
  });
  await redis.set(`bot:state:${userId}`, payload, 'EX', STATE_TTL);
}

/** Latido global del worker (para saber si el bot está vivo). */
export async function heartbeat(): Promise<void> {
  await redis.set('bot:heartbeat', new Date().toISOString());
}

/** Añade una línea a la consola de actividad del usuario. */
export async function logEvent(
  userId: string,
  message: string,
  level: LogLevel = 'info',
): Promise<void> {
  const entry = JSON.stringify({ t: Date.now(), level, message });
  await redis
    .multi()
    .lpush(`bot:log:${userId}`, entry)
    .ltrim(`bot:log:${userId}`, 0, LOG_MAX - 1)
    .expire(`bot:log:${userId}`, 86400)
    .exec();
}

export interface Activity {
  state: BotState;
  message: string;
  symbol: string | null;
  updatedAt: string | null;
  botAlive: boolean;
  secondsSinceHeartbeat: number | null;
  intervalMs: number;
  lastPassAtMs: number | null;
  events: Array<{ t: number; level: LogLevel; message: string }>;
}

export async function getActivity(userId: string): Promise<Activity> {
  const [stateRaw, hb, logs, intervalRaw] = await Promise.all([
    redis.get(`bot:state:${userId}`),
    redis.get('bot:heartbeat'),
    redis.lrange(`bot:log:${userId}`, 0, LOG_MAX - 1),
    redis.get('bot:intervalMs'),
  ]);

  const state = stateRaw
    ? JSON.parse(stateRaw)
    : { state: 'idle' as BotState, message: 'En espera', symbol: null, updatedAt: null };

  const ms = hb ? Date.now() - new Date(hb).getTime() : null;
  const intervalMs = intervalRaw ? Number(intervalRaw) : config.botIntervalMs;

  return {
    ...state,
    botAlive: ms != null && ms < Math.max(300_000, intervalMs + 180_000),
    secondsSinceHeartbeat: ms != null ? Math.round(ms / 1000) : null,
    intervalMs,
    lastPassAtMs: hb ? new Date(hb).getTime() : null,
    events: logs.map((l) => JSON.parse(l)),
  };
}
