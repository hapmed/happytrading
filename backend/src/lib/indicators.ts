// Indicadores técnicos calculados desde velas reales (Binance público, sin key).
// Se usan para dar contexto numérico a la IA (RSI, tendencia, volatilidad, momentum).
import { kv } from './kv.js';

export interface Indicators {
  ok: boolean;
  source: string;
  rsi: number;
  trend: 'ALCISTA' | 'BAJISTA' | 'LATERAL';
  emaSpreadPct: number; // (EMA9/EMA21 - 1) * 100
  atrPct: number; // ATR(14) como % del precio
  momentumPct: number; // variación % de la última hora
  volRel: number; // volumen actual vs promedio (x)
  bbWidthPct: number; // ancho de Bandas de Bollinger (% del precio)
}

const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com',
];

function ema(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(0, d)) / period;
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

async function fetchKlines(binSym: string): Promise<number[][]> {
  let lastErr: unknown = null;
  for (const host of BINANCE_HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(`${host}/api/v3/klines?symbol=${binSym}&interval=5m&limit=200`, {
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const data = (await res.json()) as any[];
      return data.map((k) => [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('sin datos');
}

/** Calcula indicadores para una moneda base (p. ej. "btc"). Cache 60s. */
export async function getIndicators(base: string): Promise<Indicators | null> {
  const b = base.toLowerCase();
  if (!b || b === 'usdt' || b === 'mxn') return null;
  const binSym = `${b.toUpperCase()}USDT`;
  const cacheKey = `ta:${binSym}`;
  try {
    const cached = await kv.get(cacheKey);
    if (cached) return JSON.parse(cached) as Indicators;
  } catch {}

  try {
    const k = await fetchKlines(binSym);
    if (k.length < 30) return null;
    const closes = k.map((r) => r[4]);
    const highs = k.map((r) => r[2]);
    const lows = k.map((r) => r[3]);
    const vols = k.map((r) => r[5]);
    const last = closes[closes.length - 1];

    const eF = ema(closes, 9);
    const eS = ema(closes, 21);
    const r = rsi(closes, 14);

    const p = 14;
    let atr = 0;
    for (let i = closes.length - p; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      );
      atr += tr;
    }
    atr /= p;

    const mom = closes.length > 13 ? (last / closes[closes.length - 13] - 1) * 100 : 0;
    const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const lastVol = vols[vols.length - 1];
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const sd20 = stdev(closes.slice(-20));
    const bbWidth = sma20 > 0 ? ((4 * sd20) / sma20) * 100 : 0;

    const trend: Indicators['trend'] =
      !isFinite(eF) || !isFinite(eS) ? 'LATERAL' : eF > eS * 1.0005 ? 'ALCISTA' : eF < eS * 0.9995 ? 'BAJISTA' : 'LATERAL';

    const out: Indicators = {
      ok: true,
      source: 'binance-5m',
      rsi: isFinite(r) ? Number(r.toFixed(1)) : 50,
      trend,
      emaSpreadPct: isFinite(eF) && isFinite(eS) && eS > 0 ? Number(((eF / eS - 1) * 100).toFixed(2)) : 0,
      atrPct: last > 0 ? Number(((atr / last) * 100).toFixed(2)) : 0,
      momentumPct: Number(mom.toFixed(2)),
      volRel: avgVol > 0 ? Number((lastVol / avgVol).toFixed(2)) : 1,
      bbWidthPct: Number(bbWidth.toFixed(2)),
    };
    await kv.set(cacheKey, JSON.stringify(out), 60).catch(() => {});
    return out;
  } catch {
    return null;
  }
}
