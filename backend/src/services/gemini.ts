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

export async function generateSignal(symbol: string, ctx: MarketContext): Promise<MarketSignal> {
  const { apiKey, model } = await getGeminiConfig();
  if (!apiKey) throw new Error('Gemini API no configurada');

  const body = {
    contents: [{ parts: [{ text: buildPrompt(symbol, ctx) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 300,
      temperature: 0.2,
      // Desactiva el "thinking" de los modelos 3.x => menos tokens.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const start = Date.now();
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(`Gemini ${res.status}: ${data?.error?.message ?? 'error'}`);
  }

  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const tokensUsed: number = data?.usageMetadata?.totalTokenCount ?? 0;

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
