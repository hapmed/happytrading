import { prisma } from '../lib/prisma.js';
import { kv } from '../lib/kv.js';
import { config } from '../config.js';
import { recordUsage, isProviderAllowed, markCall, setCooldown } from '../lib/usage.js';

export interface MarketSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0..1
  reasoning: string;
  tokensUsed: number;
  latencyMs: number;
  provider?: string;
  entryPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}

export interface MarketContext {
  symbol: string;
  ticker: {
    last: string;
    bid: string;
    ask: string;
    high: string;
    low: string;
    volume: string;
  } | null;
  balances: Array<{ currency: string; available: string; total: string }>;
  recentSignals: Array<{ action: string; confidence: string }>;
  position?: { currency: string; amount: number; avgCostMxn: number | null };
  aggressive?: boolean;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const GEMINI_FALLBACKS = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash'];
const OPENROUTER_FALLBACKS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling:free',
];

const CALL_TIMEOUT = 10_000; // por intento
const SIGNAL_BUDGET = 18_000; // máximo por señal (luego devuelve HOLD)
const MAX_PER_PROVIDER = 2; // intentos por proveedor (rápido)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, opts: RequestInit, ms = CALL_TIMEOUT): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

type Res =
  | { ok: true; text: string; tokens: number; latencyMs: number }
  | { ok: false; retryable: boolean; error: string };

async function callGemini(model: string, apiKey: string, prompt: string): Promise<Res> {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 300,
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const start = Date.now();
  try {
    markCall('gemini');
    const res = await fetchWithTimeout(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - start;
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && !data?.error) {
      const tokens = data?.usageMetadata?.totalTokenCount ?? 0;
      recordUsage('gemini', tokens, true);
      return {
        ok: true,
        text: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}',
        tokens,
        latencyMs,
      };
    }
    recordUsage('gemini', 0, false);
    const status = res.status;
    if (status === 429) setCooldown('gemini', 90_000);
    const retryable = status === 429 || status === 500 || status === 503 || status === 404;
    return { ok: false, retryable, error: `Gemini ${status}: ${data?.error?.message ?? 'error'}` };
  } catch (err) {
    recordUsage('gemini', 0, false);
    return { ok: false, retryable: true, error: `Gemini: ${(err as Error).message}` };
  }
}

async function callOpenRouter(model: string, apiKey: string, prompt: string): Promise<Res> {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };
  const start = Date.now();
  try {
    markCall('openrouter');
    const res = await fetchWithTimeout(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://happytrading.hapmed.qzz.io',
        'X-Title': 'HappyTrading',
      },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - start;
    const data: any = await res.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content;
    if (res.ok && content) {
      const tokens = data?.usage?.total_tokens ?? 0;
      recordUsage('openrouter', tokens, true);
      return { ok: true, text: content, tokens, latencyMs };
    }
    recordUsage('openrouter', 0, false);
    if (res.status === 429) setCooldown('openrouter', 90_000);
    return { ok: false, retryable: true, error: `OpenRouter ${res.status}: ${data?.error?.message ?? 'sin contenido'}` };
  } catch (err) {
    recordUsage('openrouter', 0, false);
    return { ok: false, retryable: true, error: `OpenRouter: ${(err as Error).message}` };
  }
}

interface AIConfig {
  gemini: { apiKey: string; model: string };
  openrouter: { apiKey: string; model: string };
}

async function getAIConfig(): Promise<AIConfig> {
  const [g, o] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'gemini' } }),
    prisma.setting.findUnique({ where: { key: 'openrouter' } }),
  ]);
  const gv = (g?.value ?? {}) as any;
  const ov = (o?.value ?? {}) as any;
  return {
    gemini: {
      apiKey: gv.apiKey || config.geminiApiKey || '',
      model: gv.model || config.geminiModel || 'gemini-3.1-flash-lite',
    },
    openrouter: {
      apiKey: ov.apiKey || config.openrouterApiKey || '',
      model: ov.model || config.openrouterModel || 'google/gemma-4-31b-it:free',
    },
  };
}

function buildPrompt(symbol: string, ctx: MarketContext): string {
  const t = ctx.ticker;
  const mxn = ctx.balances.find((b) => b.currency === 'mxn');
  const recent = ctx.recentSignals.map((s) => s.action[0]).join(',') || '-';
  const p = ctx.position;
  const posLine = p
    ? `tienes=${p.amount} ${p.currency}${p.avgCostMxn ? ` costo_promedio=${p.avgCostMxn}` : ''}`
    : 'tienes=0';
  return [
    `Trader cripto${ctx.aggressive ? ' AGRESIVO (busca maximizar ganancia)' : ''}. Par ${symbol}.`,
    `last=${t?.last ?? '-'} bid=${t?.bid ?? '-'} ask=${t?.ask ?? '-'} vol24h=${t?.volume ?? '-'}`,
    `MXN_disponible=${mxn?.available ?? '0'}`,
    posLine,
    `señales_previas=${recent}`,
    ctx.aggressive
      ? `Estrategia AGRESIVA de SCALPING: prioriza monedas muy VOLÁTILES; compra pequeña y frecuente en el impulso; SELL rápido al primer beneficio o si el impulso se agota (para rotar). Objetivo: muchas compras/ventas pequeñas y rápidas.`
      : `Si tienes el activo y conviene vender (o tomar ganancia / cortar pérdida) responde SELL.`,
    `Incluye niveles numéricos: "entry" (precio de compra), "takeProfit" y "stopLoss".`,
    `Responde SOLO JSON: {"action":"BUY"|"SELL"|"HOLD","confidence":0.0-1.0,"reasoning":"<=40 chars","entry":0,"takeProfit":0,"stopLoss":0}`,
  ].join(' ');
}

function extractJson(text: string): any {
  let t = text.trim().replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(t);
  } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return {};
}

function parseSignal(symbol: string, text: string, tokensUsed: number, latencyMs: number, provider: string): MarketSignal {
  const parsed = extractJson(text);
  const action: MarketSignal['action'] = ['BUY', 'SELL', 'HOLD'].includes(parsed.action) ? parsed.action : 'HOLD';
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  return {
    symbol,
    action,
    confidence,
    reasoning: String(parsed.reasoning ?? '').slice(0, 80),
    tokensUsed,
    latencyMs,
    provider,
    entryPrice: Number(parsed.entry) > 0 ? Number(parsed.entry) : 0,
    takeProfitPrice: Number(parsed.takeProfit) > 0 ? Number(parsed.takeProfit) : 0,
    stopLossPrice: Number(parsed.stopLoss) > 0 ? Number(parsed.stopLoss) : 0,
  };
}

interface Attempt {
  provider: string;
  model: string;
  key: string;
  run: (model: string, key: string, prompt: string) => Promise<Res>;
}

interface CustomProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  requestsPerDay?: number;
  requestsPerMinute?: number;
}

async function getProviders(): Promise<CustomProvider[]> {
  try {
    const s = await prisma.setting.findUnique({ where: { key: 'providers' } });
    const arr = s?.value as any;
    return Array.isArray(arr) ? arr.filter((p) => p?.apiKey && p?.baseUrl && p?.name) : [];
  } catch {
    return [];
  }
}

/** Proveedor genérico OpenAI-compatible (Groq, GitHub Models, Mistral, Together, etc.). */
async function callOpenaiCompat(p: CustomProvider, model: string, prompt: string): Promise<Res> {
  const url = `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 400,
    temperature: 0.2,
  };
  const start = Date.now();
  try {
    markCall(p.name);
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - start;
    const data: any = await res.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content;
    if (res.ok && content) {
      const tokens = data?.usage?.total_tokens ?? 0;
      recordUsage(p.name, tokens, true);
      return { ok: true, text: content, tokens, latencyMs };
    }
    recordUsage(p.name, 0, false);
    if (res.status === 429) setCooldown(p.name, 90_000);
    return { ok: false, retryable: true, error: `${p.name} ${res.status}: ${data?.error?.message ?? 'sin contenido'}` };
  } catch (err) {
    recordUsage(p.name, 0, false);
    return { ok: false, retryable: true, error: `${p.name}: ${(err as Error).message}` };
  }
}

function interleave(list: Attempt[]): Attempt[] {
  const g = list.filter((a) => a.provider === 'gemini');
  const o = list.filter((a) => a.provider !== 'gemini');
  const out: Attempt[] = [];
  const max = Math.max(g.length, o.length);
  for (let i = 0; i < max; i++) {
    if (g[i]) out.push(g[i]);
    if (o[i]) out.push(o[i]);
  }
  return out;
}

/**
 * Genera una señal intercalando Gemini y OpenRouter, con presupuesto de tiempo.
 * Si tarda demasiado o todos fallan, devuelve HOLD (nunca bloquea la pasada).
 */
export async function generateSignal(symbol: string, ctx: MarketContext): Promise<MarketSignal> {
  const work = (async (): Promise<MarketSignal> => {
    const cfg = await getAIConfig();
    const attempts: Attempt[] = [];
    if (cfg.gemini.apiKey && (await isProviderAllowed('gemini'))) {
      for (const m of uniq([cfg.gemini.model, ...GEMINI_FALLBACKS]).slice(0, MAX_PER_PROVIDER)) {
        attempts.push({ provider: 'gemini', model: m, key: cfg.gemini.apiKey, run: callGemini });
      }
    }
    if (cfg.openrouter.apiKey && (await isProviderAllowed('openrouter'))) {
      for (const m of uniq([cfg.openrouter.model, ...OPENROUTER_FALLBACKS]).slice(0, MAX_PER_PROVIDER)) {
        attempts.push({ provider: 'openrouter', model: m, key: cfg.openrouter.apiKey, run: callOpenRouter });
      }
    }

    // Proveedores extra OpenAI-compatible (Groq, GitHub Models, Mistral, etc.)
    for (const p of await getProviders()) {
      const lim = {
        requestsPerDay: p.requestsPerDay ?? 500,
        tokensPerDay: 1_000_000_000,
        requestsPerMinute: p.requestsPerMinute ?? 6,
      };
      if (!(await isProviderAllowed(p.name, lim))) continue;
      for (const m of uniq(p.models ?? []).slice(0, MAX_PER_PROVIDER)) {
        attempts.push({ provider: p.name, model: m, key: p.apiKey, run: (mo, _k, pr) => callOpenaiCompat(p, mo, pr) });
      }
    }

    if (!attempts.length) throw new Error('Sin IA disponible (límites diarios alcanzados o no configurada)');

    const interleaved = interleave(attempts);
    let offset = 0;
    try {
      const n = await kv.incr('ai:rotation');
      offset = n % interleaved.length;
    } catch {}
    const ordered = [...interleaved.slice(offset), ...interleaved.slice(0, offset)];

    const prompt = buildPrompt(symbol, ctx);
    const errors: string[] = [];
    for (const a of ordered) {
      const r = await a.run(a.model, a.key, prompt);
      if (r.ok) return parseSignal(symbol, r.text, r.tokens, r.latencyMs, a.provider);
      errors.push(`${a.provider}:${r.error}`);
    }
    throw new Error(errors.join(' | '));
  })();

  const timeout = new Promise<MarketSignal>((resolve) =>
    setTimeout(
      () => resolve({ symbol, action: 'HOLD', confidence: 0, reasoning: 'IA lenta (timeout)', tokensUsed: 0, latencyMs: SIGNAL_BUDGET }),
      SIGNAL_BUDGET,
    ),
  );

  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    // Todos los proveedores fallaron → HOLD (no rompe la pasada)
    return { symbol, action: 'HOLD', confidence: 0, reasoning: `sin IA: ${(err as Error).message.slice(0, 40)}`, tokensUsed: 0, latencyMs: 0 };
  }
}
