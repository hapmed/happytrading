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
  private quote: string;

  constructor(creds: { apiKey: string; apiSecret: string; quote?: string }) {
    this.keyId = creds.apiKey;
    this.secret = creds.apiSecret;
    this.quote = (creds.quote ?? 'mxn').toLowerCase();
  }

  private sign(qs: string): string {
    return crypto.createHmac('sha256', this.secret).update(qs).digest('hex');
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any> = {}, signed = false, host = BASE): Promise<T> {
    const url = new URL(host + path);
    const entries: Record<string, any> = { ...params };
    if (signed) {
      entries.timestamp = Date.now();
      entries.recvWindow = 5000;
    }
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
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

  /** Consulta cruda (solo diagnóstico): permite pegarle a cualquier endpoint firmado. */
  async raw<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any> = {}, signed = true, host = BASE): Promise<T> {
    return this.request<T>(method, path, params, signed, host);
  }

  // ── Saldos SOLO Spot (para operar) ────────────────────────────────
  async spotBalance(): Promise<Array<{ currency: string; available: string; locked: string; total: string }>> {
    const d = await this.request<{ balances: Array<{ asset: string; free: string; locked: string }> }>('GET', '/api/v3/account', {}, true);
    return (d.balances ?? []).map((b) => ({
      currency: String(b.asset).toLowerCase(),
      available: String(Number(b.free ?? 0)),
      locked: String(Number(b.locked ?? 0)),
      total: String(Number(b.free ?? 0) + Number(b.locked ?? 0)),
    }));
  }

  // ── Saldos SOLO Funding (la BÓVEDA) ───────────────────────────────
  async fundingBalance(): Promise<Array<{ currency: string; available: string; total: string }>> {
    const f = await this.request<any>('POST', '/sapi/v1/asset/get-funding-asset', {}, true).catch(() => []);
    return (Array.isArray(f) ? f : []).map((x: any) => ({
      currency: String(x.asset).toLowerCase(),
      available: String(Number(x.free ?? 0)),
      total: String(Number(x.free ?? 0) + Number(x.freeze ?? 0)),
    }));
  }

  // ── Saldos en Binance Simple Earn (Flexible) ──────────────────────
  // En Spot aparecen como "LD<activo>" (p.ej. LDUSDT); el bot debe poder
  // verlos (para valorar) y rescatarlos (para operar).
  async earnBalance(): Promise<Array<{ currency: string; available: string; total: string; productId: string }>> {
    const r = await this.request<any>('GET', '/sapi/v1/simple-earn/flexible/position', { size: 100 }, true).catch(() => null);
    return (r?.rows ?? []).map((x: any) => ({
      currency: String(x.asset ?? '').toLowerCase(),
      available: String(Number(x.totalAmount ?? 0)),
      total: String(Number(x.totalAmount ?? 0)),
      productId: String(x.productId ?? ''),
    }));
  }

  /** Rescata (redeem) de Simple Earn Flexible → Spot, para poder operar. */
  async earnRedeem(productId: string, amount: number, type: 'FAST' | 'NORMAL' = 'FAST'): Promise<any> {
    return this.request('POST', '/sapi/v1/simple-earn/flexible/redeem', {
      productId,
      amount: String(amount),
      type,
      destAccount: 'SPOT',
    }, true);
  }

  /** Transferencia universal entre carteras (MAIN_FUNDING / FUNDING_MAIN / UMFUTURE_MAIN...). */
  async transfer(
    type: 'MAIN_FUNDING' | 'FUNDING_MAIN' | 'MAIN_UMFUTURE' | 'UMFUTURE_MAIN',
    asset: string,
    amount: number,
  ): Promise<void> {
    await this.request('POST', '/sapi/v1/asset/transfer', { type, asset, amount: String(amount) }, true);
  }

  /** Saldo en Futuros (USDⓈ-M) — incluye cuánto es TRANSFERIBLE de verdad. */
  async futuresBalance(): Promise<Array<{ currency: string; available: string; total: string; maxWithdraw: string }>> {
    const r = await this.request<any>('GET', '/fapi/v2/balance', {}, true, 'https://fapi.binance.com').catch(() => []);
    return (Array.isArray(r) ? r : []).map((x: any) => ({
      currency: String(x.asset ?? '').toLowerCase(),
      available: String(Number(x.availableBalance ?? 0)),
      total: String(Number(x.balance ?? 0)),
      maxWithdraw: String(Number(x.maxWithdrawAmount ?? 0)),
    }));
  }

  /** Convierte entre activos (Binance Convert) — cotización caduca en segundos, por eso se acepta de inmediato. */
  async convert(fromAsset: string, toAsset: string, fromAmount: number): Promise<any> {
    const q = await this.request<any>('POST', '/sapi/v1/convert/getQuote', {
      fromAsset,
      toAsset,
      fromAmount: String(fromAmount),
    }, true);
    // La nueva API no devuelve quoteId; la cotización se identifica por validTimestamp.
    const quoteId = q?.quoteId ?? q?.validTimestamp;
    if (!quoteId) throw new Error('Convert: sin cotización');
    // Aceptar de inmediato (la cotización caduca en segundos).
    return this.request<any>('POST', '/sapi/v1/convert/acceptQuote', { quoteId: String(quoteId) }, true);
  }

  /**
   * Convierte saldos pequeños ("dust") a BNB. Es la ÚNICA vía para liquidar
   * monedas cuyo valor queda por debajo del mínimo de orden (no se pueden vender en Spot).
   */
  async dustConvert(assets: string[]): Promise<any> {
    return this.request<any>('POST', '/sapi/v1/asset/dust', { asset: assets.map((a) => a.toUpperCase()) }, true);
  }

  /** Variante: convierte los saldos pequeños a BTC (a veces acepta los que el de BNB rechaza). */
  async dustConvertBtc(assets: string[]): Promise<any> {
    return this.request<any>('POST', '/sapi/v1/asset/dust-btc', { asset: assets.map((a) => a.toUpperCase()) }, true);
  }

  // ── Saldos (Spot + Simple Earn + Funding, para la valuación) ───────
  // `funding: false` deja FUERA la bóveda (cartera Funding) → así el dinero
  // que "se mueve" se ve separado de lo que ya está guardado.
  async balance(opts: { funding?: boolean } = {}): Promise<Array<{ currency: string; available: string; locked: string; total: string }>> {
    const includeFunding = opts.funding !== false;
    const [spot, funding, earn] = await Promise.all([
      this.request<{ balances: Array<{ asset: string; free: string; locked: string }> }>('GET', '/api/v3/account', {}, true),
      includeFunding
        ? this.request<any>('POST', '/sapi/v1/asset/get-funding-asset', {}, true).catch(() => [])
        : Promise.resolve([]),
      this.earnBalance().catch(() => []),
    ]);
    const map = new Map<string, { free: number; locked: number }>();
    const add = (asset: string, free: number, locked: number) => {
      const cur = String(asset).toLowerCase();
      const prev = map.get(cur) ?? { free: 0, locked: 0 };
      map.set(cur, { free: prev.free + free, locked: prev.locked + locked });
    };
    // Simple Earn aparece como "LD<activo>" en Spot → lo contamos aparte para no duplicar.
    const earnLd = new Set(earn.map((e) => `ld${e.currency}`));
    for (const b of spot.balances ?? []) {
      const a = String(b.asset).toLowerCase();
      if (earnLd.has(a)) continue;
      add(a, Number(b.free ?? 0), Number(b.locked ?? 0));
    }
    for (const e of earn) add(e.currency, Number(e.available ?? 0), 0);
    for (const f of Array.isArray(funding) ? funding : []) {
      add(f.asset, Number(f.free ?? 0), Number(f.freeze ?? 0) + Number(f.locked ?? 0) + Number(f.withdrawing ?? 0));
    }
    return [...map.entries()].map(([currency, v]) => ({
      currency,
      available: String(v.free),
      locked: String(v.locked),
      total: String(v.free + v.locked),
    }));
  }

  /** Mueve fondos de la cartera Funding a Spot (para que el bot pueda operar). */
  async sweepFundingToSpot(): Promise<void> {
    try {
      const f = await this.request<any>('POST', '/sapi/v1/asset/get-funding-asset', {}, true);
      for (const a of Array.isArray(f) ? f : []) {
        const amt = Number(a.free ?? 0);
        if (amt > 0 && ['usdt', 'mxn', 'usdc'].includes(String(a.asset).toLowerCase())) {
          await this.request('POST', '/sapi/v1/asset/transfer', { type: 'FUNDING_MAIN', asset: a.asset, amount: String(amt) }, true).catch(() => {});
        }
      }
    } catch {}
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

  // ── Libros disponibles y sus mínimos ─────────────────────────────
  async availableBooks(): Promise<Array<{ book: string; minimumAmount: number; minimumValue: number; tickSize: number; stepSize: number }>> {
    const d = await this.request<any>('GET', '/api/v3/exchangeInfo', { permissions: 'SPOT' });
    const out: Array<{ book: string; minimumAmount: number; minimumValue: number; tickSize: number; stepSize: number }> = [];
    for (const s of d.symbols ?? []) {
      if (s.status !== 'TRADING') continue;
      if (String(s.quoteAsset).toUpperCase() !== this.quote.toUpperCase()) continue;
      const lot = (s.filters ?? []).find((f: any) => f.filterType === 'LOT_SIZE') ?? {};
      const notional = (s.filters ?? []).find((f: any) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') ?? {};
      const price = (s.filters ?? []).find((f: any) => f.filterType === 'PRICE_FILTER') ?? {};
      out.push({
        book: fromSymbol(s.symbol),
        minimumAmount: Number(lot.minQty ?? 0),
        minimumValue: Number(notional.minNotional ?? 0),
        tickSize: Number(price.tickSize ?? 0),
        stepSize: Number(lot.stepSize ?? 0),
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

  // ── Depósitos (para no contarlos como ganancia) ───────────────────
  async deposits(): Promise<Array<{ wid: string; status: string; created_at: string; currency: string; amount: string }>> {
    const d = await this.request<any[]>('GET', '/sapi/v1/capital/deposit/hisrec', { limit: 50 }, true);
    return (d ?? []).map((x: any) => {
      const st = String(x.status);
      const status = st === '1' || /success/i.test(st) ? 'complete' : st;
      return {
        wid: String(x.id ?? x.txId ?? ''),
        status,
        created_at: new Date(Number(x.insertTime ?? Date.now())).toISOString(),
        currency: String(x.coin ?? '').toLowerCase(),
        amount: String(x.amount ?? '0'),
      };
    });
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

  /**
   * Retiro de MXN por SPEI a una CLABE (Binance México / Medá).
   * Requiere permiso de Retiros + IP whitelist.
   */
  async fiatWithdrawMxn(params: { amountMxn: number; clabe: string; beneficiary: string; bank?: string }) {
    const accountInfo = JSON.stringify({
      accountNumber: params.clabe,
      beneficiaryName: params.beneficiary,
      ...(params.bank ? { bankName: params.bank } : {}),
    });
    // El retiro fiat (SPEI) de Binance requiere los parámetros en el BODY (form-encoded).
    // La firma se calcula sobre los mismos parámetros (incl. timestamp) y va en la query string.
    const bodyParams: Record<string, any> = {
      currency: 'MXN',
      apiPaymentMethod: 'WITHDRAW_MEDA',
      amount: params.amountMxn.toFixed(2),
      accountInfo,
      timestamp: Date.now(),
      recvWindow: 5000,
    };
    const qs = new URLSearchParams(bodyParams).toString();
    const signature = this.sign(qs);
    const url = `https://api.binance.com/sapi/v2/fiat/withdraw?signature=${signature}`;
    const body = new URLSearchParams({
      currency: bodyParams.currency,
      apiPaymentMethod: bodyParams.apiPaymentMethod,
      amount: bodyParams.amount,
      accountInfo: bodyParams.accountInfo,
    }).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': this.keyId, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.code && data.code < 0)) {
      throw new Error(`Binance ${res.status}: ${data?.msg ?? JSON.stringify(data).slice(0, 150)}`);
    }
    return data;
  }

  /** Historial de retiros fiat (MXN). */
  async fiatWithdrawHistory() {
    return this.request<any[]>('GET', '/sapi/v1/fiat/orders', { transactionType: 1, rows: 50 }, true);
  }

  /** Movimientos FIAT (MXN/SPEI): depósitos y retiros, para no contarlos como ganancia. */
  async fiatMovements(): Promise<Array<{ wid: string; status: string; created_at: string; currency: string; amount: string; kind: 'DEPOSIT' | 'WITHDRAWAL' }>> {
    const [deps, wds] = await Promise.all([
      this.request<any>('GET', '/sapi/v1/fiat/orders', { transactionType: 0, rows: 50 }, true).catch(() => ({ data: [] })),
      this.request<any>('GET', '/sapi/v1/fiat/orders', { transactionType: 1, rows: 50 }, true).catch(() => ({ data: [] })),
    ]);
    const map = (arr: any[], kind: 'DEPOSIT' | 'WITHDRAWAL') =>
      (arr ?? []).map((x: any) => ({
        wid: String(x.orderNo ?? x.orderId ?? ''),
        status: String(x.status ?? ''),
        created_at: new Date(Number(x.createTime ?? Date.now())).toISOString(),
        currency: String(x.fiatCurrency ?? 'mxn').toLowerCase(),
        amount: String(x.amount ?? x.indicatedAmount ?? '0'),
        kind,
      }));
    return [...map((deps as any).data, 'DEPOSIT'), ...map((wds as any).data, 'WITHDRAWAL')];
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
