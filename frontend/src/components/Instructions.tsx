import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

function price(n: number) {
  return `$${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
}

export default function Instructions() {
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    const load = () => api('/me/instructions').then(setRows).catch(() => {});
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);

  const badge = (s: string) => (s === 'PENDING' ? 'pending' : s === 'EXECUTED' ? 'filled' : 'sell');

  return (
    <Panel title="◈ PLAN DE LA IA → WORKER (sin IA)">
      {rows.length === 0 ? (
        <div className="muted center">La IA aún no ha dejado instrucciones.</div>
      ) : (
        <table className="retro-table">
          <thead>
            <tr>
              <th>PAR</th>
              <th>LADO</th>
              <th>CONDICIÓN</th>
              <th>ESTADO</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r) => (
              <tr key={r.id}>
                <td>{r.symbol}</td>
                <td>
                  <span className={`badge ${r.side.toLowerCase()}`}>{r.side}</span>
                </td>
                <td>
                  {r.trigger === 'immediate'
                    ? 'YA (mercado)'
                    : r.trigger === 'price_below'
                      ? `si precio ≤ ${price(r.triggerPrice)}`
                      : `si precio ≥ ${price(r.triggerPrice)}`}
                  <div className="muted" style={{ fontSize: 14 }}>
                    {r.side === 'BUY' ? `${Number(r.amountMxn).toFixed(0)} MXN` : `${Number(r.quantity)} unidades`}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </div>
                </td>
                <td>
                  <span className={`badge ${badge(r.status)}`}>{r.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
