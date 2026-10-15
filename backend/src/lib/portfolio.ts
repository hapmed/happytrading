import { prisma } from './prisma.js';
import { redis } from './redis.js';
import { decrypt } from './crypto.js';
import { BitsoClient } from '../services/bitso.js';

export interface Holding {
  currency: string;
  amount: number;
  priceMxn: number;
  valueMxn: number;
}

export interface PortfolioValuation {
  totalMxn: number;
  holdings: Holding[];
}

/**
 * Valora el portafolio en MXN usando los precios actuales de Bitso.
 * Solo valúa monedas con saldo > 0 y con par disponible en MXN.
 */
export async function valuePortfolio(client: BitsoClient, balances: any[]): Promise<PortfolioValuation> {
  const holdings: Holding[] = [];
  const priceCache = new Map<string, number>();
  let totalMxn = 0;

  for (const b of balances) {
    const currency = String(b.currency ?? '').toLowerCase();
    const amount = Number(b.total ?? 0);
    if (!amount || !currency) continue;

    let priceMxn: number;
    if (currency === 'mxn') {
      priceMxn = 1;
    } else if (priceCache.has(currency)) {
      priceMxn = priceCache.get(currency)!;
    } else {
      try {
        const t = await client.ticker(`${currency}_mxn`);
        priceMxn = Number(t?.last ?? 0);
      } catch {
        priceMxn = 0;
      }
      priceCache.set(currency, priceMxn);
    }

    const valueMxn = amount * priceMxn;
    if (valueMxn <= 0) continue;

    totalMxn += valueMxn;
    holdings.push({ currency, amount, priceMxn, valueMxn });
  }

  holdings.sort((a, b) => b.valueMxn - a.valueMxn);
  return { totalMxn: Math.round(totalMxn * 100) / 100, holdings };
}

export interface LiveValuation {
  currentValue: number;
  holdings: Holding[];
  updatedAt: string;
}

// Caché corta para no golpear la API de Bitso en cada refresco de pantalla.
const LIVE_TTL = 25;

/** Revalora el portafolio en vivo (precios actuales), con caché en Redis. */
export async function getLiveValuation(userId: string): Promise<LiveValuation | null> {
  const cacheKey = `live:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.bitsoApiKey || !user?.bitsoApiSecret) return null;

  const client = new BitsoClient({
    apiKey: decrypt(user.bitsoApiKey),
    apiSecret: decrypt(user.bitsoApiSecret),
  });

  const balances = await client.balance();
  const val = await valuePortfolio(client, balances);
  const result: LiveValuation = {
    currentValue: val.totalMxn,
    holdings: val.holdings,
    updatedAt: new Date().toISOString(),
  };
  await redis.set(cacheKey, JSON.stringify(result), 'EX', LIVE_TTL);
  return result;
}
