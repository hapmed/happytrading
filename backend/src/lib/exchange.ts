// Cliente de exchange: la app opera SOLO con Binance.
// (Se eliminó Bitso y Alpaca.)
import { prisma } from './prisma.js';
import { decrypt } from './crypto.js';
import { BinanceClient } from './binance.js';

export type ExchangeClient = BinanceClient;

export interface ExchangeUser {
  id: string;
  quote?: string | null;
}

export const exchangeName = (): string => 'binance';

/** Moneda de cotización del usuario ('mxn' | 'usdt'). */
export function quoteOf(user: ExchangeUser): string {
  const q = (user.quote ?? 'mxn').toLowerCase();
  return q === 'usdt' ? 'usdt' : 'mxn';
}

/** La app es Binance-only: siempre hay credenciales globales (o el cliente devuelve null). */
export function hasExchangeCreds(_user: ExchangeUser): boolean {
  return true;
}

/** Crea el cliente de Binance (null si no está configurado en la config global). */
export async function makeExchangeClient(user: ExchangeUser): Promise<ExchangeClient | null> {
  const s = await prisma.setting.findUnique({ where: { key: 'binance' } });
  const v = (s?.value ?? {}) as any;
  if (!v?.apiKey || !v?.secret) return null;
  return new BinanceClient({
    apiKey: String(v.apiKey),
    apiSecret: decrypt(String(v.secret)),
    quote: quoteOf(user),
  });
}
