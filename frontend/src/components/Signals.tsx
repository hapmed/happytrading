import React from 'react';
import { Panel } from './Retro';

function base(s: string) {
  return String(s).replace('_mxn', '').replace('_usdt', '').toUpperCase();
}

/**
 * Últimas señales de IA — EFICIENTE: una fila por moneda (la más reciente) y
 * las de acción (BUY/SELL) primero. Los HOLD repetidos se colapsan.
 */
export default function Signals({ signals }: { signals: any[] }) {
  // Una sola señal por símbolo (la más reciente; el array viene ordenado desc).
  const seen = new Set<string>();
  const latest: any[] = [];
  for (const s of signals) {
    const sym = String(s.symbol);
    if (seen.has(sym)) continue;
    seen.add(sym);
    latest.push(s);
  }
  const action = latest.filter((s) => String(s.action).toUpperCase() !== 'HOLD');
  const holds = latest.filter((s) => String(s.action).toUpperCase() === 'HOLD');
  const show = [...action, ...holds].slice(0, 10);

  return (
    <Panel title="◈ ÚLTIMAS SEÑALES DE IA">
      {/* Onda animada "en vivo" */}
      <div className="sig-wave">
        {Array.from({ length: 24 }).map((_, i) => (
          <i key={i} style={{ animationDelay: `${(i % 8) * 0.12}s` }} />
        ))}
      </div>

      <div className="sig-summary">
        <b>{action.length}</b> de acción · <b>{holds.length}</b> en HOLD · <span className="muted">1 fila por moneda</span>
      </div>

      {latest.length === 0 ? (
        <div className="muted center">Sin señales todavía.</div>
      ) : (
        <div className="sig-list">
          {show.map((s, i) => {
            const act = String(s.action || 'HOLD').toLowerCase();
            const conf = Math.min(100, Math.max(0, (Number(s.confidence) || 0) * 100));
            return (
              <div className={`sig-row ${act}`} key={s.id} style={{ animationDelay: `${i * 0.04}s` }}>
                <span className={`badge ${act}`}>{s.action}</span>
                <b>{base(s.symbol)}</b>
                <div className="sig-bar">
                  <div className={`sig-bar-fill ${act}`} style={{ width: `${Math.max(conf, 2)}%` }} />
                </div>
                <span className="sig-conf">{conf.toFixed(0)}%</span>
                <span className="sig-reason">{s.reasoning || '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
