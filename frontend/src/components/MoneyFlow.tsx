import React from 'react';
import { Panel, Stat } from './Retro';

function base(s: string) {
  return String(s).split('_')[0].toUpperCase();
}
function money(n: number) {
  return Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Empareja compras→ventas (FIFO) para saber el resultado de cada venta. */
function roundTrips(trades: any[]) {
  const chrono = [...trades].reverse();
  const queues: Record<string, Array<{ qty: number; cost: number }>> = {};
  const pnl: Record<string, { pnl: number; pct: number }> = {};
  for (const t of chrono) {
    const sym = t.symbol;
    const price = Number(t.price) || 0;
    if (t.side === 'BUY') {
      const qty = price > 0 ? Number(t.amount) / price : 0;
      (queues[sym] ||= []).push({ qty, cost: Number(t.amount) || 0 });
    } else {
      let left = Number(t.amount) || 0;
      const proceeds = left * price;
      let cost = 0;
      const q = queues[sym] || [];
      while (left > 1e-12 && q.length) {
        const lot = q[0];
        const take = Math.min(lot.qty, left);
        const c = lot.qty > 0 ? lot.cost * (take / lot.qty) : 0;
        cost += c;
        left -= take;
        lot.qty -= take;
        lot.cost -= c;
        if (lot.qty <= 1e-12) q.shift();
      }
      const p = proceeds - cost;
      pnl[t.id] = { pnl: p, pct: cost > 0 ? (p / cost) * 100 : 0 };
    }
  }
  return pnl;
}

/** COMPRADO vs VENDIDO, con el resultado (ganancia/pérdida) de cada venta. */
export default function MoneyFlow({ trades }: { trades: any[] }) {
  const pnl = roundTrips(trades);
  const buys = trades.filter((t) => t.side === 'BUY');
  const sells = trades.filter((t) => t.side === 'SELL');
  const totalBought = buys.reduce((s, t) => s + Number(t.amount || 0), 0);
  const totalSold = sells.reduce((s, t) => s + Number(t.amount || 0) * Number(t.price || 0), 0);
  const net = sells.reduce((s, t) => s + (pnl[t.id]?.pnl ?? 0), 0);
  const wins = sells.filter((t) => (pnl[t.id]?.pnl ?? 0) > 0).length;
  const losses = sells.filter((t) => (pnl[t.id]?.pnl ?? 0) < 0).length;

  // Barras: los últimos movimientos. Compra = cian · Venta ganada = verde · Venta perdida = rojo.
  const chart = trades.slice(0, 22).reverse();
  const vals = chart.map((t) => (t.side === 'BUY' ? Number(t.amount) : Number(t.amount) * Number(t.price)));
  const maxV = Math.max(0.0001, ...vals);

  return (
    <Panel title="◈ COMPRADO vs VENDIDO (con resultado)">
      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <Stat label="COMPRADO" value={`$${money(totalBought)}`} accent="cyan" />
        <Stat label="VENDIDO" value={`$${money(totalSold)}`} accent="magenta" />
        <Stat
          label={net >= 0 ? 'RESULTADO ✅' : 'RESULTADO ❌'}
          value={`${net >= 0 ? '+' : '−'}$${money(Math.abs(net))}`}
          accent={net >= 0 ? 'green' : 'red'}
        />
        <Stat label="GANADAS" value={`${wins}`} accent="green" />
        <Stat label="PERDIDAS" value={`${losses}`} accent="red" />
      </div>

      {chart.length === 0 ? (
        <div className="muted center">Todavía no hay compras ni ventas que graficar 📊</div>
      ) : (
        <>
          <div className="moneyflow">
            {chart.map((t, i) => {
              const isBuy = t.side === 'BUY';
              const v = isBuy ? Number(t.amount) : Number(t.amount) * Number(t.price);
              const h = Math.max(8, (v / maxV) * 100);
              const rt = pnl[t.id];
              const cls = isBuy ? 'mf-buy' : rt && rt.pnl >= 0 ? 'mf-win' : 'mf-loss';
              return (
                <div className="mf-col" key={t.id} title={`${t.side} ${base(t.symbol)} · $${v.toFixed(2)}${rt ? ` · ${rt.pct >= 0 ? '+' : ''}${rt.pct.toFixed(2)}%` : ''}`}>
                  <div className="mf-bar-wrap">
                    <div className={`mf-bar ${cls}`} style={{ height: `${h}%`, animationDelay: `${i * 0.05}s` }}>
                      {!isBuy && rt ? (
                        <span className={`mf-pct ${rt.pnl >= 0 ? 'up' : 'down'}`}>
                          {rt.pct >= 0 ? '+' : ''}
                          {rt.pct.toFixed(1)}%
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className="mf-name">{base(t.symbol)}</span>
                </div>
              );
            })}
          </div>
          <div className="mf-legend">
            <span><i className="mf-dot mf-buy" /> Compras</span>
            <span><i className="mf-dot mf-win" /> Ventas con GANANCIA</span>
            <span><i className="mf-dot mf-loss" /> Ventas con PÉRDIDA</span>
            <span><i className="mf-dot mf-max" /> ── nivel más alto</span>
          </div>
        </>
      )}
    </Panel>
  );
}
