import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

function money(n: number) {
  return n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Positions() {
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    const load = () => api('/me/positions').then(setRows).catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  return (
    <Panel title="◈ MIS POSICIONES (abiertas por el bot)">
      {rows.length === 0 ? (
        <div className="muted center">Aún no hay posiciones abiertas (el bot comprará cuando detecte oportunidad).</div>
      ) : (
        <table className="retro-table">
          <thead>
            <tr>
              <th>PAR</th>
              <th>CANTIDAD</th>
              <th>COSTO</th>
              <th>PRECIO</th>
              <th>PnL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol}>
                <td>{r.symbol}</td>
                <td>{Number(r.baseAmount).toLocaleString('es-MX')}</td>
                <td>${money(Number(r.avgCostMxn))}</td>
                <td>${money(Number(r.priceMxn))}</td>
                <td className={Number(r.pnl) >= 0 ? 'pnl-up' : 'pnl-down'}>
                  {Number(r.pnl) >= 0 ? '+' : ''}${money(Number(r.pnl))} (
                  {Number(r.pnlPct) >= 0 ? '+' : ''}
                  {Number(r.pnlPct).toFixed(1)}%)
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
