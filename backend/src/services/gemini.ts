import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';

export interface MarketSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0..1
  reasoning: string;
  tokensUsed: number;
  latencyMs: number;
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

// Modelos de respaldo si el principal está saturado (503) o ya no existe (404).
const FALLBACK_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-2.5-flash-lite',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getGeminiConfig(): Promise<{ apiKey: string; model: string }> {
  const s = await prisma.setting.findUnique({ where: { key: 'gemini' } });
  const v = (s?.value ?? {}) as any;
  return {
    apiKey: v.apiKey || config.geminiApiKey || '',
    model: v.model || config.geminiModel || 'gemini-3.1-flash-lite',
  };
}

/** Prompt MUY corto para minimizar el consumo de tokens. */
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

type CallResult =
  | { ok: true; text: string; tokens: number; latencyMs: number }
  | { ok: false; retryable: boolean; error: string };

async function callModel(model: string, apiKey: string, prompt: string): Promise<CallResult> {
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
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
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
    // 429/500/503 = saturado; 404 = modelo retirado → probar el siguiente modelo.
    const retryable = status === 429 || status === 500 || status === 503 || status === 404;
    return { ok: false, retryable, error: `Gemini ${status}: ${data?.error?.message ?? 'error'}` };
  } catch (err) {
    return { ok: false, retryable: true, error: `Gemini red: ${(err as Error).message}` };
  }
}

function parseSignal(symbol: string, text: string, tokensUsed: number, latencyMs: number): MarketSignal {
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { action: 'HOLD', confidence: 0, reasoning: 'parse-error' };
  }
  const action: MarketSignal['action'] = ['BUY', 'SELL', 'HOLD'].includes(parsed.action)
    ? parsed.action
    : 'HOLD';
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  return {
    symbol,
    action,
    confidence,
    reasoning: String(parsed.reasoning ?? '').slice(0, 80),
    tokensUsed,
    latencyMs,
  };
}

/**
 * Genera una señal con Gemini de forma resiliente:
 * reintenta con varios modelos y con backoff si la API está saturada (503/429).
 */
export async function generateSignal(symbol: string, ctx: MarketContext): Promise<MarketSignal> {
  const { apiKey, model } = await getGeminiConfig();
  if (!apiKey) throw new Error('Gemini API no configurada');

  const models = [...new Set([model, ...FALLBACK_MODELS])];
  const prompt = buildPrompt(symbol, ctx);
  let lastError = 'Gemini no disponible';

  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const m of models) {
      const r = await callModel(m, apiKey, prompt);
      if (r.ok) return parseSignal(symbol, r.text, r.tokens, r.latencyMs);
      lastError = r.error;
      if (!r.retryable) throw new Error(r.error); // ej. API key inválida → no insistir
    }
    if (attempt < 3) await sleep(1200 * attempt);
  }

  throw new Error(lastError);
}
