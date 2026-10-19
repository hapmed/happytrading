import { prisma } from './prisma.js';
import { kv } from './kv.js';
import { makeExchangeClient, hasExchangeCreds, type ExchangeClient } from './exchange.js';

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
export async function valuePortfolio(client: ExchangeClient, balances: any[]): Promise<PortfolioValuation> {
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
      // Respaldo: si no hay par en MXN (p. ej. monedas operadas en USDT),
      // valora vía USDT: precio(moneda/USDT) × precio(USDT/MXN).
      if (priceMxn <= 0) {
        try {
          const tUsd = await client.ticker(`${currency}_usdt`);
          const pUsd = Number(tUsd?.last ?? 0);
          if (pUsd > 0) {
            let usdtMxn = priceCache.get('__usdtmxn') ?? 0;
            if (!usdtMxn) {
              const tU = await client.ticker('usdt_mxn');
              usdtMxn = Number(tU?.last ?? 0);
              priceCache.set('__usdtmxn', usdtMxn);
            }
            if (usdtMxn > 0) priceMxn = pUsd * usdtMxn;
          }
        } catch {}
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
  const cached = await kv.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !hasExchangeCreds(user)) return null;

  const client = await makeExchangeClient(user);
  if (!client) return null;

  const balances = await client.balance({ funding: false }); // la bóveda va aparte
  const val = await valuePortfolio(client, balances);
  const result: LiveValuation = {
    currentValue: val.totalMxn,
    holdings: val.holdings,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(cacheKey, JSON.stringify(result), LIVE_TTL);
  return result;
}
