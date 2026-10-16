import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, Stat } from './Retro';

function money(n: number) {
  return Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function base(symbol: string) {
  return String(symbol).split('_')[0].toUpperCase();
}

export default function Positions() {
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    const load = () => api('/me/positions').then(setRows).catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  const totalValue = rows.reduce((s, r) => s + Number(r.valueMxn || 0), 0);
  const totalPnl = rows.reduce((s, r) => s + Number(r.pnl || 0), 0);

  return (
    <Panel title="◈ MIS POSICIONES">
      <p className="muted mb" style={{ fontSize: 16 }}>
        Monedas que el bot compró y <b>aún tienes</b> (sin vender). La ganancia es contra su costo de compra.
      </p>

      {rows.length === 0 ? (
        <div className="muted center">Aún no hay posiciones abiertas.</div>
      ) : (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <Stat label="EN POSICIONES" value={`$${money(totalValue)}`} accent="cyan" />
            <Stat label={totalPnl >= 0 ? 'GANANCIA' : 'PÉRDIDA'} value={`${totalPnl >= 0 ? '+' : '−'}$${money(Math.abs(totalPnl))}`} accent={totalPnl >= 0 ? 'green' : 'magenta'} />
          </div>

          <div className="pos-list">
            {rows.map((r) => {
              const pnl = Number(r.pnl || 0);
              const pnlPct = Number(r.pnlPct || 0);
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
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}
