import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

function price(n: number) {
  return `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
}
function base(s: string) {
  return String(s).split('_')[0].toUpperCase();
}

export default function Instructions() {
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    const load = () => api('/me/instructions').then(setRows).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const pending = rows.filter((r) => r.status === 'PENDING');
  const executed = rows.filter((r) => r.status === 'EXECUTED');
  const expired = rows.filter((r) => r.status === 'EXPIRED' || r.status === 'CANCELLED');

  const condition = (r: any) =>
    r.trigger === 'immediate'
      ? 'YA (mercado)'
      : r.trigger === 'price_below'
        ? `si precio ≤ ${price(r.triggerPrice)}`
        : `si precio ≥ ${price(r.triggerPrice)}`;

  return (
    <Panel title="◈ LO QUE LA IA LE MANDA AL WORKER" className="plan-panel">
      {/* Flujo animado IA -> Worker */}
      <div className="plan-flow">
        <span className="plan-node">🧠 IA</span>
        <span className="plan-arrow">
          <span className="plan-dot" />
          <span className="plan-dot" />
          <span className="plan-dot" />
        </span>
        <span className="plan-node">⚙️ WORKER</span>
        <span className="plan-state">
          {pending.length > 0 ? `${pending.length} en fila` : 'sin planear nada'}
        </span>
      </div>

      {/* Resumen rápido */}
      <div className="plan-summary">
        <span className="plan-pill wait">⏳ {pending.length} en fila</span>
        <span className="plan-pill ok">✔ {executed.length} cumplidas</span>
        <span className="plan-pill off">⌛ {expired.length} caducadas</span>
      </div>

      {/* Planes activos */}
      {pending.length === 0 ? (
        <div className="muted center" style={{ marginTop: 10 }}>
          La IA no tiene plan ahorita. Está pensando en grande 🤔
        </div>
      ) : (
        <div className="plan-list">
          {pending.map((r) => {
            const isBuy = r.side === 'BUY';
            const prox = Math.max(0, Math.min(100, (1 - Number(r.distancePct || 0) / 8) * 100));
            return (
              <div className={`plan-card ${isBuy ? 'buy' : 'sell'}`} key={r.id}>
                <div className="plan-card-top">
                  <span className={`badge ${isBuy ? 'buy' : 'sell'}`}>{r.side}</span>
                  <b>{base(r.symbol)}</b>
                  <span className="plan-live">
                    <span className="live-dot" /> en espera
                  </span>
                </div>
                <div className="plan-cond">{condition(r)}</div>
                <div className="plan-meta">
                  {isBuy ? `$${Number(r.amountMxn).toFixed(0)} MXN` : `${Number(r.quantity)} u.`}
                  {r.priceMxn > 0 ? ` · ahora ${price(r.priceMxn)} · faltan ${Number(r.distancePct).toFixed(1)}%` : ''}
                </div>
                <div className="plan-bar">
                  <div className="plan-bar-fill" style={{ width: `${prox}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Ejecutadas recientes */}
      {executed.length > 0 && (
        <div className="plan-done">
          {executed.slice(0, 4).map((r) => (
            <span className="plan-done-item" key={r.id}>
              ✔ {base(r.symbol)} {r.side}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}
