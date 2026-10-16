// Almacén clave-valor en MEMORIA (reemplaza a Redis en el modo de un solo contenedor).
// Suficiente para: estado de actividad, caches con TTL, contadores y cola interna.
type Entry = { v: any; exp?: number };

const store = new Map<string, Entry>();

function live(key: string): Entry | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.exp && e.exp <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return e;
}

export const kv = {
  async get(key: string): Promise<string | null> {
    const e = live(key);
    return e ? (e.v as string) : null;
  },
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    store.set(key, { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
  },
  async incr(key: string): Promise<number> {
    const e = live(key);
    const n = (e ? Number(e.v) : 0) + 1;
    store.set(key, { v: n });
    return n;
  },
  async lpush(key: string, value: string): Promise<void> {
    const e = live(key);
    const arr: string[] = e ? (e.v as string[]) : [];
    arr.unshift(value);
    store.set(key, { v: arr });
  },
  async rpop(key: string): Promise<string | null> {
    const e = live(key);
    if (!e) return null;
    const arr = e.v as string[];
    const v = arr.pop() ?? null;
    store.set(key, { v: arr });
    return v;
  },
  async ltrim(key: string, start: number, end: number): Promise<void> {
    const e = live(key);
    if (!e) return;
    const arr = e.v as string[];
    store.set(key, { v: arr.slice(start, end + 1) });
  },
  async lrange(key: string, start: number, end: number): Promise<string[]> {
    const e = live(key);
    if (!e) return [];
    const arr = e.v as string[];
    const s = start < 0 ? Math.max(0, arr.length + start) : start;
    const en = end < 0 ? arr.length + end : end;
    return arr.slice(s, en + 1);
  },
  async hgetall(key: string): Promise<Record<string, string>> {
    const e = live(key);
    return e ? { ...(e.v as Record<string, string>) } : {};
  },
  async hset(key: string, field: string, value: string): Promise<void> {
    const e = live(key);
    const obj = e ? { ...(e.v as Record<string, string>) } : {};
    obj[field] = value;
    store.set(key, { v: obj });
  },
  async expire(): Promise<void> {
    // no-op: la memoria no persiste TTL de los hashes (no es crítico)
  },
  async del(key: string): Promise<void> {
    store.delete(key);
  },
};
