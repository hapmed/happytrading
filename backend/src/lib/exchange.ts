// Fábrica de cliente de exchange: devuelve Bitso o Binance según el usuario.
// Los dos clientes exponen la misma interfaz (balance/ticker/availableBooks/placeOrder/withdrawals).
import { prisma } from './prisma.js';
import { decrypt } from './crypto.js';
import { BitsoClient } from '../services/bitso.js';
import { BinanceClient } from './binance.js';

export type ExchangeClient = BitsoClient | BinanceClient;

export interface ExchangeUser {
  id: string;
  exchange?: string | null;
  bitsoApiKey?: string | null;
  bitsoApiSecret?: string | null;
}

/** Nombre del exchange del usuario ('bitso' | 'binance'). */
export function exchangeOf(user: ExchangeUser): string {
  return (user.exchange ?? 'bitso').toLowerCase() === 'binance' ? 'binance' : 'bitso';
}

/** ¿El usuario tiene credenciales para operar en su exchange? */
export function hasExchangeCreds(user: ExchangeUser): boolean {
  if (exchangeOf(user) === 'binance') return true; // las llaves de Binance son globales (settings)
  return Boolean(user.bitsoApiKey && user.bitsoApiSecret);
}

/** Crea el cliente del exchange del usuario (o null si no está configurado). */
export async function makeExchangeClient(user: ExchangeUser): Promise<ExchangeClient | null> {
  if (exchangeOf(user) === 'binance') {
    const s = await prisma.setting.findUnique({ where: { key: 'binance' } });
    const v = (s?.value ?? {}) as any;
    if (!v?.apiKey || !v?.secret) return null;
    return new BinanceClient({ apiKey: String(v.apiKey), apiSecret: decrypt(String(v.secret)) });
  }
  if (!user.bitsoApiKey || !user.bitsoApiSecret) return null;
  return new BitsoClient({ apiKey: decrypt(user.bitsoApiKey), apiSecret: decrypt(user.bitsoApiSecret) });
}
