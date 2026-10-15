import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { config } from '../config.js';

export interface MarketSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0..1
  reasoning: string;
  tokensUsed: number;
  latencyMs: number;
  provider?: string;
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
    const res = await fetchWithTimeout(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - start;
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && !data?.error) {
      return {
        ok: true,
        text: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}',
        tokens: data?.usageMetadata?.totalTokenCount ?? 0,
        latencyMs,
      };
    }
    const status = res.status;
    const retryable = status === 429 || status === 500 || status === 503 || status === 404;
    return { ok: false, retryable, error: `Gemini ${status}: ${data?.error?.message ?? 'error'}` };
  } catch (err) {
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
      return { ok: true, text: content, tokens: data?.usage?.total_tokens ?? 0, latencyMs };
    }
    return { ok: false, retryable: true, error: `OpenRouter ${res.status}: ${data?.error?.message ?? 'sin contenido'}` };
  } catch (err) {
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
  return [
    `Trader cripto. Par ${symbol}.`,
    `last=${t?.last ?? '-'} bid=${t?.bid ?? '-'} ask=${t?.ask ?? '-'} vol24h=${t?.volume ?? '-'}`,
    `MXN_disponible=${mxn?.available ?? '0'}`,
    `señales_previas=${recent}`,
    `Responde SOLO JSON: {"action":"BUY"|"SELL"|"HOLD","confidence":0.0-1.0,"reasoning":"<=40 chars"}`,
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
  };
}

interface Attempt {
  provider: 'gemini' | 'openrouter';
  model: string;
  key: string;
  run: (model: string, key: string, prompt: string) => Promise<Res>;
}

function interleave(list: Attempt[]): Attempt[] {
  const g = list.filter((a) => a.provider === 'gemini');
  const o = list.filter((a) => a.provider === 'openrouter');
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
    if (cfg.gemini.apiKey) {
      for (const m of uniq([cfg.gemini.model, ...GEMINI_FALLBACKS]).slice(0, MAX_PER_PROVIDER)) {
        attempts.push({ provider: 'gemini', model: m, key: cfg.gemini.apiKey, run: callGemini });
      }
    }
    if (cfg.openrouter.apiKey) {
      for (const m of uniq([cfg.openrouter.model, ...OPENROUTER_FALLBACKS]).slice(0, MAX_PER_PROVIDER)) {
        attempts.push({ provider: 'openrouter', model: m, key: cfg.openrouter.apiKey, run: callOpenRouter });
      }
    }
    if (!attempts.length) throw new Error('IA no configurada (Gemini u OpenRouter)');

    const interleaved = interleave(attempts);
    let offset = 0;
    try {
      const n = await redis.incr('ai:rotation');
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
