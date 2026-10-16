import { hmacSha256Hex } from '../lib/crypto.js';
import { config } from '../config.js';

export interface BitsoCredentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Nonce v2 (obligatorio desde nov/2025):
 * timestamp en ms (13 dígitos) + salt aleatorio (6 dígitos) = 19 dígitos.
 */
function nonceV2(): string {
  const ts = Date.now().toString();
  const salt = Math.floor(100000 + Math.random() * 900000).toString();
  return ts + salt;
}

/**
 * Cliente del Trading API de Bitso ("bitso3").
 * Base: https://bitso.com  ·  prefijo de rutas: /api/v3/
 * La firma HMAC incluye la ruta COMPLETA (con /api/v3/) tal cual va en la URL.
 */
export class BitsoClient {
  private base: string;

  constructor(private creds: BitsoCredentials, base?: string) {
    this.base = (base ?? config.bitsoApiBase ?? 'https://bitso.com').replace(/\/+$/, '');
  }

  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const nonce = nonceV2();
    const json = body ? JSON.stringify(body) : '';
    const message = nonce + method + path + json;
    const signature = hmacSha256Hex(this.creds.apiSecret, message);

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bitso ${this.creds.apiKey}:${nonce}:${signature}`,
        'Content-Type': 'application/json',
      },
      body: body ? json : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      const e: any = data;
      const code = e?.error?.code ? `[${e.error.code}] ` : '';
      const detail = e?.error?.message ?? JSON.stringify(data);
      const err: any = new Error(`Bitso API ${res.status}: ${code}${detail}`);
      err.bitsoCode = e?.error?.code;
      err.bitsoBody = data;
      throw err;
    }
    return data as T;
  }

  async accountStatus() {
    const data = await this.request<{ payload: any }>('GET', '/api/v3/account_status/');
    return data.payload;
  }

  async balance() {
    const data = await this.request<{ payload: { balances: any[] } }>('GET', '/api/v3/balance/');
    return data.payload?.balances ?? [];
  }

  async ticker(book: string) {
    const data = await this.request<{ payload: any }>('GET', `/api/v3/ticker/?book=${encodeURIComponent(book)}`);
    return data.payload;
  }

  async availableBooks() {
    const data = await this.request<{ payload: any[] }>('GET', '/api/v3/available_books/');
    return data.payload ?? [];
  }

  async placeOrder(params: {
    book: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    major?: string;
    minor?: string;
    price?: string;
    time_in_force?: string;
  }) {
    const data = await this.request<{ payload: any }>('POST', '/api/v3/orders/', params);
    return data.payload;
  }

  async openOrders(book?: string) {
    const q = book ? `?book=${encodeURIComponent(book)}` : '';
    const data = await this.request<{ payload: any[] }>('GET', `/api/v3/open_orders/${q}`);
    return data.payload ?? [];
  }

  async userTrades(book?: string, limit = 25) {
    const params = new URLSearchParams();
    if (book) params.set('book', book);
    params.set('limit', String(limit));
    const data = await this.request<{ payload: any[] }>('GET', `/api/v3/user_trades/?${params.toString()}`);
    return data.payload ?? [];
  }

  async cancelOrder(oid: string) {
    const data = await this.request<{ payload: any }>('DELETE', `/api/v3/orders/${oid}/`);
    return data.payload;
  }

  // Depósitos (incluye transferencias SPEI/funding) y retiros — para no contarlos como ganancia
  async deposits(limit = 50) {
    const data = await this.request<{ payload: any[] }>('GET', `/api/v3/deposits/?limit=${limit}`);
    return data.payload ?? [];
  }

  async withdrawals(limit = 50) {
    const data = await this.request<{ payload: any[] }>('GET', `/api/v3/withdrawals/?limit=${limit}`);
    return data.payload ?? [];
  }

  // Métodos de retiro disponibles (para saber los campos requeridos de SPEI/CLABE).
  async withdrawalMethods() {
    const data = await this.request<{ payload: any[] }>('GET', '/api/v3/withdrawal_methods/');
    return data.payload ?? [];
  }

  /** GET arbitrario (diagnóstico de endpoints). */
  async probe(path: string) {
    return this.request<any>('GET', path);
  }

  /**
   * Retiro SPEI a una CLABE bancaria (método "praxis").
   * Bitso puede exigir confirmación por PIN/OTP según el monto.
   */
  async createSpeiWithdrawal(params: {
    amountMxn: number;
    clabe: string;
    beneficiary: string;
    notes?: string;
    numericRef?: string;
    originId?: string;
  }) {
    const body: Record<string, any> = {
      currency: 'mxn',
      method: 'praxis',
      amount: params.amountMxn.toFixed(2),
      clabe: params.clabe,
      beneficiary: params.beneficiary,
    };
    if (params.notes) body.notes_ref = params.notes;
    if (params.numericRef) body.numeric_ref = params.numericRef;
    if (params.originId) body.origin_id = params.originId;
    const data = await this.request<{ payload: any }>('POST', '/api/v3/withdrawals/', body);
    return data.payload;
  }
}
