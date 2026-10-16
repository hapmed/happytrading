// Cliente de Binance (Spot) — API compatible con BitsoClient para reutilizar
// toda la estrategia: balance(), ticker(), availableBooks(), placeOrder(), withdrawals().
// Traduce los pares internos `btc_mxn` ⇄ símbolos de Binance `BTCMXN`.
import crypto from 'node:crypto';

const BASE = 'https://api.binance.com';

function toSymbol(book: string): string {
  const [b, q] = book.toLowerCase().split('_');
  return `${b.toUpperCase()}${q.toUpperCase()}`;
}

const QUOTES = ['MXN', 'USDT', 'USDC', 'BRL', 'ARS', 'COP'];
function fromSymbol(sym: string): string {
  const up = sym.toUpperCase();
  for (const q of QUOTES) {
    if (up.endsWith(q)) return `${up.slice(0, -q.length).toLowerCase()}_${q.toLowerCase()}`;
  }
  return up.toLowerCase();
}

export class BinanceClient {
  private keyId: string;
  private secret: string;

  constructor(creds: { apiKey: string; apiSecret: string }) {
    this.keyId = creds.apiKey;
    this.secret = creds.apiSecret;
  }

  private sign(qs: string): string {
    return crypto.createHmac('sha256', this.secret).update(qs).digest('hex');
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any> = {}, signed = false): Promise<T> {
    const url = new URL(BASE + path);
    const entries: Record<string, any> = { ...params };
    if (signed) {
      entries.timestamp = Date.now();
      entries.recvWindow = 5000;
    }
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
    if (signed) {
      const qs = url.searchParams.toString();
      url.searchParams.set('signature', this.sign(qs));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { 'X-MBX-APIKEY': this.keyId },
        signal: ctrl.signal,
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || (data && data.code && data.code < 0)) {
        throw new Error(`Binance ${res.status}: ${data?.msg ?? JSON.stringify(data).slice(0, 120)}`);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Saldos ────────────────────────────────────────────────────────
  async balance(): Promise<Array<{ currency: string; available: string; locked: string; total: string }>> {
    const d = await this.request<{ balances: Array<{ asset: string; free: string; locked: string }> }>(
      'GET',
      '/api/v3/account',
      {},
      true,
    );
    return (d.balances ?? []).map((b) => {
      const free = Number(b.free ?? 0);
      const locked = Number(b.locked ?? 0);
      return {
        currency: String(b.asset).toLowerCase(),
        available: String(free),
        locked: String(locked),
        total: String(free + locked),
      };
    });
  }

  // ── Precio (ticker 24h) ───────────────────────────────────────────
  async ticker(book: string): Promise<{ last: string; bid: string; ask: string; high: string; low: string; volume: string }> {
    const sym = toSymbol(book);
    const d = await this.request<any>('GET', '/api/v3/ticker/24hr', { symbol: sym });
    return {
      last: String(d.lastPrice ?? '0'),
      bid: String(d.bidPrice ?? '0'),
      ask: String(d.askPrice ?? '0'),
      high: String(d.highPrice ?? '0'),
      low: String(d.lowPrice ?? '0'),
      volume: String(d.quoteVolume ?? d.volume ?? '0'),
    };
  }

  // ── Libros disponibles (contra MXN) y sus mínimos ─────────────────
  async availableBooks(): Promise<Array<{ book: string; minimumAmount: number; minimumValue: number; tickSize: number }>> {
    const d = await this.request<any>('GET', '/api/v3/exchangeInfo', { permissions: 'SPOT' });
    const out: Array<{ book: string; minimumAmount: number; minimumValue: number; tickSize: number }> = [];
    for (const s of d.symbols ?? []) {
      if (s.status !== 'TRADING') continue;
      if (String(s.quoteAsset).toUpperCase() !== 'MXN') continue;
      const lot = (s.filters ?? []).find((f: any) => f.filterType === 'LOT_SIZE') ?? {};
      const notional = (s.filters ?? []).find((f: any) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') ?? {};
      const price = (s.filters ?? []).find((f: any) => f.filterType === 'PRICE_FILTER') ?? {};
      out.push({
        book: fromSymbol(s.symbol),
        minimumAmount: Number(lot.minQty ?? 0),
        minimumValue: Number(notional.minNotional ?? 0),
        tickSize: Number(price.tickSize ?? 0),
      });
    }
    return out;
  }

  // ── Órdenes (market) ──────────────────────────────────────────────
  async placeOrder(params: {
    book: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    major?: string;
    minor?: string;
    price?: string;
  }): Promise<{ oid?: number | string }> {
    const symbol = toSymbol(params.book);
    const body: Record<string, any> = { symbol, side: params.side.toUpperCase(), type: params.type.toUpperCase() };
    if (params.side === 'buy') {
      // Comprar gastando `minor` (MXN) → quoteOrderQty
      if (params.minor) body.quoteOrderQty = Number(params.minor).toFixed(2);
      else if (params.major) body.quantity = params.major;
    } else {
      // Vender `major` (cantidad del activo) → quantity
      if (params.major) body.quantity = params.major;
    }
    if (params.type === 'limit' && params.price) {
      body.price = params.price;
      body.timeInForce = 'GTC';
    }
    const d = await this.request<any>('POST', '/api/v3/order', body, true);
    return { oid: d.orderId };
  }

  async openOrders(book?: string) {
    const params: Record<string, any> = {};
    if (book) params.symbol = toSymbol(book);
    return this.request<any[]>('GET', '/api/v3/openOrders', params, true);
  }

  async cancelOrder(oid: string, book?: string) {
    const params: Record<string, any> = { orderId: oid };
    if (book) params.symbol = toSymbol(book);
    return this.request<any>('DELETE', '/api/v3/order', params, true);
  }

  // ── Retiros (para detectar salidas) ───────────────────────────────
  async withdrawals(): Promise<Array<{ wid: string; status: string; created_at: string; currency: string; amount: string }>> {
    const d = await this.request<any[]>('GET', '/sapi/v1/capital/withdraw/history', {}, true);
    // status: 4=processing,6=completed, others; normalizamos a texto
    return (d ?? []).map((w: any) => {
      const st = Number(w.status);
      const status = st === 6 ? 'complete' : st === 4 ? 'processing' : String(w.status ?? '');
      return {
        wid: String(w.id ?? w.withdrawOrderId ?? ''),
        status,
        created_at: new Date(Number(w.applyTime ?? Date.now())).toISOString(),
        currency: String(w.coin ?? '').toLowerCase(),
        amount: String(w.amount ?? '0'),
      };
    });
  }

  async accountStatus() {
    return this.request<any>('GET', '/api/v3/account', {}, true);
  }

  async ping(): Promise<boolean> {
    try {
      await this.request<any>('GET', '/api/v3/ping');
      return true;
    } catch {
      return false;
    }
  }
}
