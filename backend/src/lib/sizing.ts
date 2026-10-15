// Dimensionado de posición por riesgo — adaptado de "position-sizer"
// (tradermonty/claude-trading-skills, MIT). Método de fracción fija:
// arriesgar `riskPct`% del capital, con distancia al stop de `stopLossPct`%.

export function fixedFractionalSize(equityMxn: number, riskPct: number, stopLossPct: number): number {
  if (equityMxn <= 0 || riskPct <= 0 || stopLossPct <= 0) return 0;
  return equityMxn * (riskPct / stopLossPct);
}
