// Cliente mínimo para la API de Trading de Alpaca (acciones de EE.UU.).
// Auth por headers APCA-API-KEY-ID / APCA-API-SECRET-KEY.

export interface AlpacaCreds {
  keyId: string;
  secret: string;
  baseUrl: string;
}

const TIMEOUT = 15_000;

async function req<T>(c: AlpacaCreds, path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: {
        'APCA-API-KEY-ID': c.keyId,
        'APCA-API-SECRET-KEY': c.secret,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Alpaca ${res.status}: ${data?.message ?? JSON.stringify(data).slice(0, 120)}`);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export const alpaca = {
  account: (c: AlpacaCreds) => req<any>(c, '/v2/account'),
  positions: (c: AlpacaCreds) => req<any[]>(c, '/v2/positions'),
  clock: (c: AlpacaCreds) => req<any>(c, '/v2/clock'),
  orders: (c: AlpacaCreds, status = 'all', limit = 25) =>
    req<any[]>(c, `/v2/orders?status=${status}&limit=${limit}&direction=desc`),
  asset: (c: AlpacaCreds, symbol: string) => req<any>(c, `/v2/assets/${encodeURIComponent(symbol)}`),
  latestQuote: async (c: AlpacaCreds, symbol: string) =>
    req<any>({ ...c, baseUrl: 'https://data.alpaca.markets' }, `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`),
  placeOrder: (
    c: AlpacaCreds,
    body: { symbol: string; qty?: string; notional?: string; side: 'buy' | 'sell'; type: 'market' | 'limit'; limit_price?: string; time_in_force?: string },
  ) =>
    req<any>(c, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({ time_in_force: 'day', ...body }),
    }),
};
