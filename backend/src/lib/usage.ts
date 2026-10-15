// Registro de uso de IA (tokens y peticiones por día y proveedor) + freno de límites.
import { prisma } from './prisma.js';

export interface DayUsage {
  requests: number;
  tokens: number;
  errors: number;
}

export interface Limits {
  gemini: { requestsPerDay: number; tokensPerDay: number };
  openrouter: { requestsPerDay: number; tokensPerDay: number };
}

// Contadores en memoria (día|proveedor) — se persisten a BD periódicamente.
const mem = new Map<string, DayUsage>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordUsage(provider: string, tokens: number, ok: boolean): void {
  const key = `${today()}|${provider}`;
  const u = mem.get(key) ?? { requests: 0, tokens: 0, errors: 0 };
  u.requests += 1;
  u.tokens += tokens || 0;
  if (!ok) u.errors += 1;
  mem.set(key, u);
}

export function getUsage(): { day: string; providers: Record<string, DayUsage> } {
  const day = today();
  const providers: Record<string, DayUsage> = {};
  for (const [k, v] of mem) {
    const [d, p] = k.split('|');
    if (d === day) providers[p] = v;
  }
  return { day, providers };
}

export async function getLimits(): Promise<Limits> {
  let v: any = {};
  try {
    const s = await prisma.setting.findUnique({ where: { key: 'limits' } });
    v = s?.value ?? {};
  } catch {}
  return {
    gemini: {
      requestsPerDay: Number(v?.gemini?.requestsPerDay) || 1500,
      tokensPerDay: Number(v?.gemini?.tokensPerDay) || 1_000_000,
    },
    openrouter: {
      requestsPerDay: Number(v?.openrouter?.requestsPerDay) || 50,
      tokensPerDay: Number(v?.openrouter?.tokensPerDay) || 1_000_000,
    },
  };
}

/** ¿Se puede usar este proveedor sin pasarse del límite diario? */
export async function isProviderAllowed(provider: string): Promise<boolean> {
  const limits = (await getLimits()) as any;
  const l = limits[provider];
  if (!l) return true;
  const u = getUsage().providers[provider] ?? { requests: 0, tokens: 0, errors: 0 };
  return u.requests < l.requestsPerDay && u.tokens < l.tokensPerDay;
}

export async function flushUsage(): Promise<void> {
  for (const [k, v] of mem) {
    const [day, provider] = k.split('|');
    try {
      await prisma.usageDay.upsert({
        where: { day_provider: { day, provider } },
        update: { requests: v.requests, tokens: v.tokens, errors: v.errors },
        create: { day, provider, requests: v.requests, tokens: v.tokens, errors: v.errors },
      });
    } catch {}
  }
}

export async function loadUsage(): Promise<void> {
  const day = today();
  const rows = await prisma.usageDay.findMany({ where: { day } }).catch(() => []);
  for (const r of rows) mem.set(`${r.day}|${r.provider}`, { requests: r.requests, tokens: r.tokens, errors: r.errors });
}
