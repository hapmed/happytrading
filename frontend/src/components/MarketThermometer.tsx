import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

interface Coin {
  currency: string;
  zScore: number;
  bbPos: number;
  rsi: number;
  stat: 'BARATO' | 'CARO' | 'NEUTRO';
  momentumPct: number;
  atrPct: number;
  trend: string;
}

/**
 * Termómetro de mercado: muestra qué tan BARATO o CARO está cada moneda según
 * estadística (z-score y posición dentro de las Bandas de Bollinger).
 * Más a la izquierda/verde = más barato = mejor para comprar.
 */
export default function MarketThermometer() {
  const [coins, setCoins] = useState<Coin[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api('/me/market')
        .then((d: any) => {
          setCoins(d.coins ?? []);
          setErr(null);
        })
        .catch((e: any) => setErr(String(e?.message ?? e)));
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  const color = (s: string) => (s === 'BARATO' ? 'var(--green)' : s === 'CARO' ? 'var(--red)' : 'var(--muted)');

  return (
    <Panel title="◈ TERMÓMETRO DE MERCADO">
      <div className="thermo-help">
        Qué tan <b className="thermo-cheap">barato</b> ↔ <b className="thermo-expensive">caro</b> está cada moneda (z-score + Bandas de Bollinger, velas 5m).
        A la <b>izquierda/verde</b> = más barato = mejor para comprar.
      </div>
      {err && <div className="error-msg">No se pudo cargar el termómetro: {err}</div>}
      <div className="thermo-list">
        {coins.map((c) => (
          <div className="thermo-row" key={c.currency}>
            <b className="thermo-coin">{c.currency.toUpperCase()}</b>
            <span className={`badge thermo-badge ${c.stat === 'BARATO' ? 'filled' : c.stat === 'CARO' ? 'sell' : ''}`}>{c.stat}</span>
            <div className="thermo-bar">
              <div className="thermo-track" />
              <div
                className="thermo-mark"
                style={{ left: `${Math.min(100, Math.max(0, c.bbPos))}%`, background: color(c.stat) }}
              />
            </div>
            <span className="thermo-num thermo-z">z {c.zScore >= 0 ? '+' : ''}{c.zScore}</span>
            <span className="thermo-num thermo-rsi">RSI {c.rsi}</span>
            <span className="thermo-num thermo-mom">{c.momentumPct >= 0 ? '+' : ''}{c.momentumPct}%</span>
          </div>
        ))}
        {!coins.length && !err && <div className="muted">Cargando…</div>}
      </div>
    </Panel>
  );
}
