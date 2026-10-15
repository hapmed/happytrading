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
