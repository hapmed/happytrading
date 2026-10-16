// Límites por libro (min/max) según el exchange (Bitso o Binance). Cacheado.
import { kv } from './kv.js';

export interface BookLimits {
  book: string;
  minimumAmount: number; // en moneda mayor
  minimumValue: number; // amount*price, en moneda menor (MXN)
  maximumAmount: number;
  maximumValue: number;
  tickSize: number;
}

/** Acepta la respuesta de Bitso (snake_case) o de Binance (camelCase). */
export async function getBookLimits(
  client: { availableBooks: () => Promise<any[]> },
  exchange = 'bitso',
): Promise<Map<string, BookLimits>> {
  const KEY = `booklimits:${exchange}`;
  const TTL = 900; // 15 min
  try {
    const cached = await kv.get(KEY);
    if (cached) {
      const arr: BookLimits[] = JSON.parse(cached);
      return new Map(arr.map((b) => [b.book, b]));
    }
  } catch {}

  const books = await client.availableBooks();
  const list: BookLimits[] = (books ?? []).map((b: any) => ({
    book: String(b.book ?? ''),
    minimumAmount: Number(b.minimumAmount ?? b.minimum_amount ?? 0),
    minimumValue: Number(b.minimumValue ?? b.minimum_value ?? 0),
    maximumAmount: Number(b.maximumAmount ?? b.maximum_amount ?? 0),
    maximumValue: Number(b.maximumValue ?? b.maximum_value ?? 0),
    tickSize: Number(b.tickSize ?? b.tick_size ?? 0),
  }));

  try {
    await kv.set(KEY, JSON.stringify(list), TTL);
  } catch {}

  return new Map(list.map((b) => [b.book, b]));
}
