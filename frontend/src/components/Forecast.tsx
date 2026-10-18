import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

function fmtMin(m: number | null | undefined): string {
  if (m == null || !isFinite(m)) return '—';
  if (m <= 1) return '¡ya merito!';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 48) return 'lejos';
  return r ? `${h} h ${r} min` : `${h} h`;
}
function pn(v: number) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function money(n: number) {
  return Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function px(n: number) {
  return Number(n || 0).toPrecision(4);
}

/** ¿CUÁNDO VENDE O COMPRA? Corredor de precio con el tiempo estimado. */
export default function Forecast() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    const load = () =>
      api('/me/forecast')
        .then((d: any) => setItems(d?.items ?? []))
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  const pos = items.filter((i) => i.kind === 'POS');
  const plans = items.filter((i) => i.kind === 'PLAN');

  return (
    <Panel title="◈ ¿CUÁNDO VENDE O COMPRA? (plan a futuro)">
      {items.length === 0 && (
        <div className="muted center">Nada en juego ahorita. El bot está esperando una ganga 🎯</div>
      )}

      {pos.map((p) => {
        const total = p.distSl + p.distTp || 1;
        const at = Math.min(97, Math.max(3, (p.distSl / total) * 100));
        return (
          <div className="fc-row" key={`p-${p.symbol}`}>
            <div className="fc-top">
              <b className="fc-base">{p.base}</b>
              <span className={p.pnlPct >= 0 ? 'pnl-up' : 'pnl-down'}>{pn(p.pnlPct)}</span>
              <span className="muted">${money(p.valor)}</span>
            </div>

            <div className="fc-track">
              <div className="fc-zone-up" />
              <div className="fc-zone-down" style={{ width: `${at}%` }} />
              <div className="fc-marker" style={{ left: `${at}%` }} />
            </div>

            <div className="fc-ends">
              <span className="fc-sl">
                🔴 corta −{p.distSl.toFixed(2)}% <b>{fmtMin(p.etaSlMin)}</b>
              </span>
              <span className="fc-tp">
                🟢 vende +{p.distTp.toFixed(2)}% <b>{fmtMin(p.etaTpMin)}</b>
              </span>
            </div>

            <div className="fc-note">
              TP <b>{px(p.tp)}</b> · SL <b>{px(p.sl)}</b> · {p.aFavor ? 'subiendo 📈' : 'bajando 📉'}
            </div>
          </div>
        );
      })}

      {plans.map((i: any, k: number) => (
        <div className="fc-row fc-plan" key={`i-${i.symbol}-${k}`}>
          <div className="fc-top">
            <b className="fc-base">{i.base}</b>
            <span className={`badge ${i.side === 'BUY' ? 'buy' : 'sell'}`}>{i.side}</span>
            <span className="muted">
              {i.trigger === 'immediate'
                ? 'al instante'
                : `si precio ${i.trigger === 'price_below' ? '≤' : '≥'} ${px(i.triggerPrice)}`}
            </span>
          </div>
          <div className="fc-ends">
            <span className="muted">faltan <b>{i.dist.toFixed(2)}%</b> para que entre</span>
            <span className="muted">expira en <b>{fmtMin(i.expiresInMin)}</b></span>
          </div>
        </div>
      ))}

      <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
        ⏱ Los tiempos son un <b>estimado</b> con el movimiento reciente de cada moneda (el mercado puede cambiarlo
        en cualquier momento).
      </p>
    </Panel>
  );
}
