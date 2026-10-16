import React from 'react';
import { Panel } from './Retro';

function base(s: string) {
  return String(s).replace('_mxn', '').replace('_usdt', '').toUpperCase();
}

/** Últimas señales de la IA con barra de confianza animada. */
export default function Signals({ signals }: { signals: any[] }) {
  const maxConf = Math.max(0.0001, ...signals.slice(0, 12).map((s) => Number(s.confidence) || 0));
  return (
    <Panel title="◈ ÚLTIMAS SEÑALES DE IA">
      {/* Onda animada "en vivo" */}
      <div className="sig-wave">
        {Array.from({ length: 24 }).map((_, i) => (
          <i key={i} style={{ animationDelay: `${(i % 8) * 0.12}s` }} />
        ))}
      </div>

      {signals.length === 0 ? (
        <div className="muted center">Sin señales todavía.</div>
      ) : (
        <div className="sig-list">
          {signals.slice(0, 12).map((s, i) => {
            const act = String(s.action || 'HOLD').toLowerCase();
            const conf = Math.min(100, Math.max(0, (Number(s.confidence) || 0) * 100));
            return (
              <div className={`sig-row ${act}`} key={s.id} style={{ animationDelay: `${i * 0.04}s` }}>
                <span className={`badge ${act}`}>{s.action}</span>
                <b>{base(s.symbol)}</b>
                <div className="sig-bar">
                  <div className={`sig-bar-fill ${act}`} style={{ width: `${conf}%` }} />
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
