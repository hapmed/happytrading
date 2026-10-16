import React from 'react';
import { Panel } from './Retro';

function time(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
function base(s: string) {
  return String(s).replace('_mxn', '').replace('_usdt', '').toUpperCase();
}

/** Empareja compras→ventas (FIFO) por par para estimar la ganancia de cada ciclo. */
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

/** Historial de operaciones con mini-gráfica animada (bucle). */
export default function RecentTrades({ trades }: { trades: any[] }) {
  const pnl = roundTrips(trades);
  const chart = trades.slice(0, 26).reverse();
  const vals = chart.map((t) => (t.side === 'BUY' ? Number(t.amount) : Number(t.amount) * Number(t.price)));
  const maxV = Math.max(0.0001, ...vals);

  return (
    <Panel title="◈ HISTORIAL · COMPRADOS Y VENDIDOS">
      {trades.length === 0 ? (
        <div className="muted center">Sin operaciones todavía.</div>
      ) : (
        <>
          {/* Mini gráfica animada de las últimas operaciones */}
          <div className="mini-chart">
            {chart.map((t, i) => {
              const v = t.side === 'BUY' ? Number(t.amount) : Number(t.amount) * Number(t.price);
              const h = Math.max(6, (v / maxV) * 100);
              return (
                <i
                  key={t.id}
                  className={t.side === 'BUY' ? 'mc-buy' : 'mc-sell'}
                  style={{ height: `${h}%`, animationDelay: `${i * 0.06}s` }}
                  title={`${t.side} ${base(t.symbol)} $${v.toFixed(2)}`}
                />
              );
            })}
          </div>

          <div className="trades-list">
            {trades.slice(0, 15).map((t, i) => {
              const isBuy = t.side === 'BUY';
              const value = isBuy ? Number(t.amount) : Number(t.amount) * Number(t.price);
              const rt = pnl[t.id];
              return (
                <div className={`trade-row ${isBuy ? 'buy' : 'sell'}`} key={t.id} style={{ animationDelay: `${i * 0.05}s` }}>
                  <span className={`badge ${isBuy ? 'buy' : 'sell'}`}>{t.side}</span>
                  <b>{base(t.symbol)}</b>
                  <span className="muted">@ ${Number(t.price).toLocaleString('es-MX', { maximumFractionDigits: 2 })}</span>
                  {rt ? (
                    <span className={rt.pnl >= 0 ? 'pnl-up' : 'pnl-down'}>
                      {rt.pnl >= 0 ? '+' : '−'}${Math.abs(rt.pnl).toFixed(2)} ({rt.pct >= 0 ? '+' : ''}
                      {rt.pct.toFixed(1)}%)
                    </span>
                  ) : (
                    <span className="trade-val">${value.toFixed(2)}</span>
                  )}
                  <span className="trade-time">{time(t.createdAt)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}
