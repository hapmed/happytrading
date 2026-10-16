import React from 'react';
import { Panel } from './Retro';

function base(s: string) {
  return String(s).replace('_mxn', '').toUpperCase();
}

export default function Signals({ signals }: { signals: any[] }) {
  return (
    <Panel title="◈ ÚLTIMAS SEÑALES DE IA">
      {signals.length === 0 ? (
        <div className="muted center">Sin señales todavía.</div>
      ) : (
        <div className="sig-list">
          {signals.slice(0, 12).map((s, i) => {
            const act = String(s.action || 'HOLD').toLowerCase();
            return (
              <div className={`sig-row ${act}`} key={s.id} style={{ animationDelay: `${i * 0.04}s` }}>
                <span className={`badge ${act}`}>{s.action}</span>
                <b>{base(s.symbol)}</b>
                <span className="sig-conf">{(Number(s.confidence) * 100).toFixed(0)}%</span>
                <span className="sig-reason">{s.reasoning || '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
