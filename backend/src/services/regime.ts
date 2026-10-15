// Régimen de mercado cripto — adaptado de "crypto-regime-analyzer"
// (tradermonty/claude-trading-skills, MIT). Datos gratis sin API key:
// CoinGecko (tendencias/BTC/global) + Binance (funding de perpetuos).
import { redis } from '../lib/redis.js';

export type RegimeZone = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

export interface RegimeComponent {
  key: string;
  name: string;
  weight: number; // 0..1
  score: number | null; // 0..100 o null si no hay datos
  signal: string;
  dataAvailable: boolean;
}

export interface RegimeResult {
  score: number;
  zone: RegimeZone;
  guidance: string;
  updatedAt: string;
  cached: boolean;
  components: RegimeComponent[];
}

const CACHE_KEY = 'regime:composite';
const CACHE_TTL = 1800; // 30 min

const STABLES = new Set([
  'usdt', 'usdc', 'usde', 'dai', 'fdusd', 'tusd', 'busd', 'usds', 'pyusd', 'usd1', 'rlusd',
]);

const UA = { accept: 'application/json', 'user-agent': 'HappyTradingBot/1.0' };

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

async function fetchFunding(): Promise<number | null> {
  const data = await fetchJson('https://fapi.binance.com/fapi/v1/premiumIndex');
  if (!Array.isArray(data)) return null;
  const majors = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT'];
  const rates = data.filter((d: any) => majors.includes(d.symbol)).map((d: any) => Number(d.lastFundingRate));
  if (!rates.length) return null;
  return rates.reduce((a: number, b: number) => a + b, 0) / rates.length;
}

/** Dirección de la dominancia de BTC usando historial local acumulado. */
async function dominanceDirection(current: number): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  let hist: Record<string, string> = {};
  try {
    hist = await redis.hgetall('regime:dom');
    await redis.hset('regime:dom', today, String(current));
    await redis.expire('regime:dom', 60 * 60 * 24 * 45);
  } catch {}
  const dates = Object.keys(hist).sort();
  if (dates.length < 1) return null;
  const prev = Number(hist[dates[dates.length - 1]]);
  if (!isFinite(prev)) return null;
  return current - prev;
}

export async function computeRegime(): Promise<RegimeResult> {
  const [markets, global, btcChart] = await Promise.all([
    fetchJson(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&price_change_percentage=7d,30d',
    ).catch(() => null),
    fetchJson('https://api.coingecko.com/api/v3/global').catch(() => null),
    fetchJson('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=250&interval=daily').catch(
      () => null,
    ),
  ]);
  const funding = await fetchFunding().catch(() => null);

  const prices: number[] = (btcChart?.prices ?? []).map((p: any) => Number(p[1])).filter((n: number) => isFinite(n));
  const last = prices.length ? prices[prices.length - 1] : null;
  const ma50 = sma(prices, 50);
  const ma200 = sma(prices, 200);
  let slope = 0;
  if (prices.length >= 220) {
    const now200 = sma(prices, 200)!;
    const prev200 = sma(prices.slice(0, prices.length - 20), 200);
    if (prev200) slope = (now200 - prev200) / prev200;
  }

  const components: RegimeComponent[] = [];

  // 1) Tendencia BTC (25%)
  if (last != null && ma50 != null && ma200 != null) {
    let s = 0;
    if (last > ma50) s += 35;
    if (ma50 > ma200) s += 35;
    if (slope > 0) s += 30;
    components.push({
      key: 'btc_trend',
      name: 'Tendencia BTC',
      weight: 0.25,
      score: s,
      signal: `${last > ma50 ? '>' : '<'} 50DMA · 50DMA ${ma50 > ma200 ? '>' : '<'} 200DMA · pendiente 200DMA ${slope >= 0 ? '+' : ''}${(slope * 100).toFixed(1)}%`,
      dataAvailable: true,
    });
  } else {
    components.push({ key: 'btc_trend', name: 'Tendencia BTC', weight: 0.25, score: null, signal: 'sin datos', dataAvailable: false });
  }

  const nonStable = (markets ?? []).filter((m: any) => !STABLES.has(String(m.symbol).toLowerCase()));

  // 2) Amplitud de alts (20%): % con cambio 30d positivo
  if (nonStable.length) {
    const up = nonStable.filter((m: any) => Number(m.price_change_percentage_30d_in_currency ?? 0) > 0).length;
    const pct = (up / nonStable.length) * 100;
    components.push({
      key: 'alt_breadth',
      name: 'Amplitud de alts (30d)',
      weight: 0.2,
      score: Math.round(pct),
      signal: `${up}/${nonStable.length} en positivo (30d)`,
      dataAvailable: true,
    });
  } else {
    components.push({ key: 'alt_breadth', name: 'Amplitud de alts (30d)', weight: 0.2, score: null, signal: 'sin datos', dataAvailable: false });
  }

  // 3) Dominancia BTC (15%)
  const btcDom = global?.data?.market_cap_percentage?.btc;
  if (typeof btcDom === 'number') {
    const dir = await dominanceDirection(btcDom);
    if (dir == null) {
      components.push({
        key: 'btc_dominance',
        name: 'Dominancia BTC',
        weight: 0.15,
        score: null,
        signal: `${btcDom.toFixed(1)}% (acumulando historial)`,
        dataAvailable: false,
      });
    } else {
      // Cae la dominancia = capital rotando a alts = risk-on.
      const s = dir < -0.2 ? 75 : dir > 0.2 ? 35 : 55;
      components.push({
        key: 'btc_dominance',
        name: 'Dominancia BTC',
        weight: 0.15,
        score: s,
        signal: `${btcDom.toFixed(1)}% (${dir >= 0 ? '+' : ''}${dir.toFixed(2)} pts)`,
        dataAvailable: true,
      });
    }
  } else {
    components.push({ key: 'btc_dominance', name: 'Dominancia BTC', weight: 0.15, score: null, signal: 'sin datos', dataAvailable: false });
  }

  // 4) Funding de perpetuos (15%)
  if (funding != null) {
    const f = funding * 100; // a %
    let s: number;
    if (f <= 0) s = 55;
    else if (f <= 0.01) s = 90;
    else if (f <= 0.03) s = 70;
    else if (f <= 0.05) s = 40;
    else s = 15;
    components.push({
      key: 'funding',
      name: 'Funding perpetuos',
      weight: 0.15,
      score: s,
      signal: `${f >= 0 ? '+' : ''}${f.toFixed(3)}% / 8h`,
      dataAvailable: true,
    });
  } else {
    components.push({ key: 'funding', name: 'Funding perpetuos', weight: 0.15, score: null, signal: 'sin datos', dataAvailable: false });
  }

  // 5) Drawdown & volatilidad (15%)
  if (last != null && prices.length >= 60) {
    const max1y = Math.max(...prices.slice(-365));
    const dd = (last - max1y) / max1y;
    const ddScore = dd > -0.1 ? 85 : dd > -0.25 ? 65 : dd > -0.4 ? 45 : 25;
    const rets: number[] = [];
    for (let i = 1; i < prices.length; i++) rets.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    const vol30 = stdev(rets.slice(-30));
    const volScore = vol30 < 0.02 ? 80 : vol30 < 0.04 ? 65 : vol30 < 0.06 ? 45 : 25;
    components.push({
      key: 'drawdown_vol',
      name: 'Drawdown & volatilidad',
      weight: 0.15,
      score: Math.round(0.7 * ddScore + 0.3 * volScore),
      signal: `DD ${(dd * 100).toFixed(1)}% · vol30d ${(vol30 * 100).toFixed(2)}%`,
      dataAvailable: true,
    });
  } else {
    components.push({ key: 'drawdown_vol', name: 'Drawdown & volatilidad', weight: 0.15, score: null, signal: 'sin datos', dataAvailable: false });
  }

  // 6) Impulso / washout (10%): % con cambio 7d positivo
  if (nonStable.length) {
    const up7 = nonStable.filter((m: any) => Number(m.price_change_percentage_7d_in_currency ?? 0) > 0).length;
    const pct = (up7 / nonStable.length) * 100;
    components.push({
      key: 'momentum',
      name: 'Impulso (7d)',
      weight: 0.1,
      score: Math.round(pct),
      signal: `${up7}/${nonStable.length} en positivo (7d)`,
      dataAvailable: true,
    });
  } else {
    components.push({ key: 'momentum', name: 'Impulso (7d)', weight: 0.1, score: null, signal: 'sin datos', dataAvailable: false });
  }

  // Compuesto con redistribución proporcional de pesos de componentes sin datos
  let weightSum = 0;
  let acc = 0;
  for (const c of components) {
    if (c.dataAvailable && c.score != null) {
      weightSum += c.weight;
      acc += c.weight * c.score;
    }
  }
  const score = weightSum > 0 ? Math.round(acc / weightSum) : 50;

  const zone: RegimeZone = score >= 80 ? 'RISK_ON' : score >= 40 ? 'NEUTRAL' : 'RISK_OFF';
  const guidance =
    zone === 'RISK_ON'
      ? 'Condiciones favorables; revisa límites de riesgo antes de decidir.'
      : zone === 'NEUTRAL'
        ? 'Condiciones mixtas; sin conclusión fuerte de régimen.'
        : 'Condiciones defensivas; revisa tus controles de riesgo.';

  return { score, zone, guidance, updatedAt: new Date().toISOString(), cached: false, components };
}

/** Régimen con caché (30 min). Si falla la fuente, devuelve el último cacheado. */
export async function getRegime(force = false): Promise<RegimeResult> {
  if (!force) {
    try {
      const cachedRaw = await redis.get(CACHE_KEY);
      if (cachedRaw) return { ...JSON.parse(cachedRaw), cached: true };
    } catch {}
  }
  try {
    const result = await computeRegime();
    try {
      await redis.set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL);
    } catch {}
    return result;
  } catch (err) {
    const cachedRaw = await redis.get(CACHE_KEY).catch(() => null);
    if (cachedRaw) return { ...JSON.parse(cachedRaw), cached: true };
    throw err;
  }
}
