// Registro de uso de IA (tokens y peticiones por día y proveedor) + freno de límites.
import { prisma } from './prisma.js';

export interface DayUsage {
  requests: number;
  tokens: number;
  errors: number;
}

export interface Limits {
  gemini: { requestsPerDay: number; tokensPerDay: number; requestsPerMinute: number };
  openrouter: { requestsPerDay: number; tokensPerDay: number; requestsPerMinute: number };
}

// Contadores en memoria (día|proveedor) — se persisten a BD periódicamente.
const mem = new Map<string, DayUsage>();
// Ventana por minuto y enfriamiento por proveedor (anti-429)
const minuteWindow = new Map<string, number[]>();
const cooldownUntil = new Map<string, number>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Marca una petición hecha a un proveedor (para el límite por minuto). */
export function markCall(provider: string): void {
  const arr = minuteWindow.get(provider) ?? [];
  arr.push(Date.now());
  minuteWindow.set(provider, arr);
}

function perMinuteCount(provider: string): number {
  const now = Date.now();
  const arr = (minuteWindow.get(provider) ?? []).filter((t) => now - t < 60_000);
  minuteWindow.set(provider, arr);
  return arr.length;
}

/** Pausa un proveedor (p. ej. tras un 429) para no gastar peticiones. */
export function setCooldown(provider: string, ms: number): void {
  cooldownUntil.set(provider, Date.now() + ms);
}

export function inCooldown(provider: string): boolean {
  const t = cooldownUntil.get(provider);
  if (t == null) return false;
  if (t <= Date.now()) {
    cooldownUntil.delete(provider);
    return false;
  }
  return true;
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
      requestsPerMinute: Number(v?.gemini?.requestsPerMinute) || 12,
    },
    openrouter: {
      requestsPerDay: Number(v?.openrouter?.requestsPerDay) || 50,
      tokensPerDay: Number(v?.openrouter?.tokensPerDay) || 1_000_000,
      requestsPerMinute: Number(v?.openrouter?.requestsPerMinute) || 15,
    },
  };
}

/** ¿Se puede usar este proveedor sin pasarse del límite diario/minuto ni en enfriamiento? */
export async function isProviderAllowed(provider: string): Promise<boolean> {
  if (inCooldown(provider)) return false;
  const limits = (await getLimits()) as any;
  const l = limits[provider];
  if (!l) return true;
  const u = getUsage().providers[provider] ?? { requests: 0, tokens: 0, errors: 0 };
  if (u.requests >= l.requestsPerDay || u.tokens >= l.tokensPerDay) return false;
  const cap = Number(l.requestsPerMinute) || 0;
  if (cap > 0 && perMinuteCount(provider) >= cap) return false;
  return true;
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

export interface OrQuota {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
}

/** Consulta el uso/restante REAL de OpenRouter (sí expone endpoint). */
export async function getOpenRouterQuota(apiKey: string): Promise<OrQuota | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const d: any = await res.json();
    const data = d?.data ?? {};
    return {
      limit: typeof data.limit === 'number' ? data.limit : null,
      remaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : null,
      reset: data.limit_reset ?? null,
    };
  } catch {
    return null;
  }
}
