import React from 'react';
import { Panel } from './Retro';

function time(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function RecentTrades({ trades }: { trades: any[] }) {
  return (
    <Panel title="◈ HISTORIAL · COMPRADOS Y VENDIDOS">
      {trades.length === 0 ? (
        <div className="muted center">Sin operaciones todavía.</div>
      ) : (
        <div className="trades-list">
          {trades.slice(0, 15).map((t, i) => {
            const isBuy = t.side === 'BUY';
            const value = isBuy ? Number(t.amount) : Number(t.amount) * Number(t.price);
            return (
              <div className={`trade-row ${isBuy ? 'buy' : 'sell'}`} key={t.id} style={{ animationDelay: `${i * 0.05}s` }}>
                <span className={`badge ${isBuy ? 'buy' : 'sell'}`}>{t.side}</span>
                <b>{String(t.symbol).replace('_mxn', '').toUpperCase()}</b>
                <span className="muted">@ ${Number(t.price).toLocaleString('es-MX', { maximumFractionDigits: 2 })}</span>
                <span className="trade-val">${value.toFixed(2)}</span>
                <span className="trade-time">{time(t.createdAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
