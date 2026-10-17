// Control de fondos: los fondos operables deben estar SIEMPRE en Spot/Funding.
// Binance puede "suscribir" saldos a Simple Earn (aparecen como LD<activo> en Spot)
// y entonces el bot no los puede usar → sustos raros (valuaciones en $0, "no puedo vender").
// Este módulo los trae de vuelta a Spot automáticamente.
import type { ExchangeClient } from './exchange.js';

export interface EarnRedeem {
  asset: string;
  amount: number;
}

/** ¿El cliente soporta Simple Earn? */
function hasEarn(client: ExchangeClient): boolean {
  return typeof (client as any)?.earnBalance === 'function';
}

/** Lista lo que hay en Simple Earn (Flexible). */
export async function listEarn(client: ExchangeClient): Promise<Array<{ asset: string; amount: number; productId: string }>> {
  if (!hasEarn(client)) return [];
  try {
    const rows = await (client as any).earnBalance();
    return (rows ?? [])
      .map((e: any) => ({ asset: String(e.currency ?? '').toLowerCase(), amount: Number(e.total ?? 0), productId: String(e.productId ?? '') }))
      .filter((e: any) => e.amount > 0 && e.productId);
  } catch {
    return [];
  }
}

/**
 * Rescata TODO lo que esté en Simple Earn a Spot (para que el bot lo maneje).
 * Devuelve lo rescatado. Nunca lanza (a prueba de sustos).
 */
export async function redeemAllEarn(client: ExchangeClient): Promise<EarnRedeem[]> {
  const out: EarnRedeem[] = [];
  for (const e of await listEarn(client)) {
    try {
      await (client as any).earnRedeem(e.productId, e.amount, 'FAST');
      out.push({ asset: e.asset, amount: e.amount });
    } catch {
      // Si un activo falla (p.ej. una promoción), seguimos con los demás.
    }
  }
  return out;
}
