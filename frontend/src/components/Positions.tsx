import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, Stat } from './Retro';

function money(n: number) {
  return Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function base(symbol: string) {
  return String(symbol).split('_')[0].toUpperCase();
}

// Estilo de cada veredicto de la evaluación del bot.
const ACTION: Record<string, { label: string; fg: string; bg: string }> = {
  VENDER: { label: '▼ VENDER', fg: '#1a1a1a', bg: '#ffd400' },
  MANTENER: { label: '■ MANTENER', fg: '#06210f', bg: '#37d67a' },
  DEJAR: { label: '· DEJAR', fg: '#d7d7d7', bg: '#3a3a3a' },
};

export default function Positions() {
  const [rows, setRows] = useState<any[]>([]);
  const [review, setReview] = useState<Record<string, any>>({});

  useEffect(() => {
    const load = () => {
      api('/me/positions').then(setRows).catch(() => {});
      api('/me/review')
        .then((d: any) => {
          const m: Record<string, any> = {};
          for (const it of d?.items ?? []) m[it.base] = it;
          setReview(m);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  const totalValue = rows.reduce((s, r) => s + Number(r.valueMxn || 0), 0);
  const totalPnl = rows.reduce((s, r) => s + Number(r.pnl || 0), 0);

  return (
    <Panel title="◈ MIS POSICIONES · EVALUACIÓN">
      <p className="muted mb" style={{ fontSize: 16 }}>
        Monedas que el bot compró y <b>aún tienes</b>. El bot las evalúa cada rato y decide
        <b> venderlas </b> (si están caras) o <b>mantenerlas</b> (si aún pueden subir).
      </p>

      {rows.length === 0 ? (
        <div className="muted center">Aún no hay posiciones abiertas.</div>
      ) : (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <Stat label="EN POSICIONES" value={`$${money(totalValue)}`} accent="cyan" />
            <Stat label={totalPnl >= 0 ? 'GANANCIA' : 'PÉRDIDA'} value={`${totalPnl >= 0 ? '+' : '−'}$${money(Math.abs(totalPnl))}`} accent={totalPnl >= 0 ? 'green' : 'red'} />
          </div>

          <div className="pos-list">
            {rows.map((r) => {
              const pnl = Number(r.pnl || 0);
              const pnlPct = Number(r.pnlPct || 0);
              const key = String(r.symbol).split('_')[0];
              const ev = review[key];
              const a = ev ? ACTION[ev.action] ?? ACTION.MANTENER : null;
              return (
                <div className="pos-card" key={r.symbol}>
                  <div className="pos-top">
                    <b>{base(r.symbol)}</b>
                    <span className={pnl >= 0 ? 'pnl-up' : 'pnl-down'}>
                      {pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))} ({pnlPct >= 0 ? '+' : ''}
                      {pnlPct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="pos-detail">
                    Cantidad: <b>{Number(r.baseAmount).toLocaleString('es-MX')}</b>
                  </div>
                  <div className="pos-detail">
                    Costo: ${money(r.avgCostMxn)} · Precio: ${money(r.priceMxn)}
                  </div>
                  <div className="pos-detail">
                    Valor ahora: ${money(r.valueMxn)}
                  </div>
                  {ev && a && (
                    <div style={{ marginTop: 8 }}>
                      <span
                        className={`eval-badge eval-${String(ev.action).toLowerCase()}`}
                        style={{ color: a.fg, background: a.bg }}
                      >
                        {a.label}
                      </span>
                      <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                        {ev.reason}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {(review.home || review.pepe || review.xno) && (
        <p className="muted" style={{ fontSize: 14, marginTop: 12 }}>
          Polvo no vendible (se deja):{' '}
          {['home', 'pepe', 'xno'].filter((k) => review[k]).map((k) => k.toUpperCase()).join(' · ')}
        </p>
      )}
    </Panel>
  );
}
