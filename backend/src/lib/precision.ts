// Precisión de cantidades según el exchange.
// Binance rechaza órdenes cuya cantidad tenga más decimales de los permitidos
// por el LOT_SIZE (stepSize) del par: p.ej. SHIB solo acepta enteros.
// Sin esto, el bot podía COMPRAR pero NO VENDER (error 400 "too much precision").

/** Nº de decimales que permite un stepSize (p.ej. 1 → 0, 0.001 → 3, 1e-8 → 8). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !isFinite(step)) return 8;
  const s = step.toString();
  if (s.includes('e-')) return Math.min(18, Number(s.split('e-')[1]) || 8);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Baja la cantidad al múltiplo exacto del stepSize (nunca redondea hacia arriba). */
export function floorToStep(qty: number, step: number): number {
  if (!(qty > 0) || !isFinite(qty)) return 0;
  if (!(step > 0)) return qty;
  const d = stepDecimals(step);
  const stepped = Math.floor(qty / step + 1e-9) * step;
  return Number(stepped.toFixed(Math.min(18, d)));
}

/** Cantidad como texto válido para el exchange (con los decimales exactos del step). */
export function qtyStr(qty: number, step: number): string {
  if (!(qty > 0)) return '0';
  if (!(step > 0)) return qty.toFixed(8).replace(/\.?0+$/, '') || '0';
  const d = stepDecimals(step);
  return floorToStep(qty, step).toFixed(d);
}
