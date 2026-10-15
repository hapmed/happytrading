// Límites por libro de Bitso (min/max) según /v3/available_books/
// Cacheado en Redis para no consultarlo en cada operación.
import { redis } from './redis.js';
import { BitsoClient } from '../services/bitso.js';

const KEY = 'bitso:booklimits';
const TTL = 900; // 15 min

export interface BookLimits {
  book: string;
  minimumAmount: number; // en moneda mayor
  minimumValue: number; // amount*price, en moneda menor (MXN)
  maximumAmount: number;
  maximumValue: number;
  tickSize: number;
}

export async function getBookLimits(client: BitsoClient): Promise<Map<string, BookLimits>> {
  try {
    const cached = await redis.get(KEY);
    if (cached) {
      const arr: BookLimits[] = JSON.parse(cached);
      return new Map(arr.map((b) => [b.book, b]));
    }
  } catch {}

  const books = await client.availableBooks();
  const list: BookLimits[] = (books ?? []).map((b: any) => ({
    book: String(b.book ?? ''),
    minimumAmount: Number(b.minimum_amount ?? 0),
    minimumValue: Number(b.minimum_value ?? 0),
    maximumAmount: Number(b.maximum_amount ?? 0),
    maximumValue: Number(b.maximum_value ?? 0),
    tickSize: Number(b.tick_size ?? 0),
  }));

  try {
    await redis.set(KEY, JSON.stringify(list), 'EX', TTL);
  } catch {}

  return new Map(list.map((b) => [b.book, b]));
}
