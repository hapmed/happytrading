import { GoogleGenerativeAI } from '@google/generative-ai';
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

async function getGeminiKey(): Promise<string> {
  const s = await prisma.setting.findUnique({ where: { key: 'gemini' } });
  const stored = (s?.value as any)?.apiKey;
  return stored || config.geminiApiKey || '';
}

/**
 * Construye un prompt MUY corto para minimizar el consumo de tokens.
 * El modelo responde solo JSON.
 */
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
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error('Gemini API no configurada');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 120,
      responseMimeType: 'application/json',
    },
  });

  const prompt = buildPrompt(symbol, ctx);
  const start = Date.now();
  const result = await model.generateContent(prompt);
  const latencyMs = Date.now() - start;

  const text = result.response.text();
  const usage = result.response.usageMetadata;
  const tokensUsed = usage?.totalTokenCount ?? 0;

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
