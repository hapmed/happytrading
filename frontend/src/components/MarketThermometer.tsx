import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

interface Coin {
  currency: string;
  zScore: number;
  bbPos: number;
  rsi: number;
  stat: 'BARATO' | 'CARO' | 'NEUTRO';
}

/**
 * Termómetro 8-bit: cada moneda es un termómetro horizontal que se LLENA conforme
 * se pone CARA (verde = barato → rojo = caro). Pocos datos y sin desbordes.
 */
export default function MarketThermometer() {
  const [coins, setCoins] = useState<Coin[]>([]);

  useEffect(() => {
    const load = () => api('/me/market').then((d: any) => setCoins(d.coins ?? [])).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  const color = (s: string) => (s === 'BARATO' ? 'var(--green)' : s === 'CARO' ? 'var(--red)' : 'var(--yellow)');

  return (
    <Panel title="◈ TERMÓMETRO DE MERCADO">
      <div className="thermo2-help">
        🌡️ Mientras más <b>lleno/rojo</b>, más <b>caro</b>. Verde y vacío = <b>barato</b> (bueno para comprar).
      </div>
      <div className="thermo2-list">
        {coins.slice(0, 10).map((c) => {
          const pct = Math.min(100, Math.max(0, Number(c.bbPos) || 0));
          const col = color(c.stat);
          return (
            <div className="thermo2-row" key={c.currency}>
              <b className="thermo2-coin">{String(c.currency).toUpperCase()}</b>
              <div className="thermo2-tube">
                <div className="thermo2-fill" style={{ width: `${pct}%`, background: col, boxShadow: `0 0 10px ${col}` }} />
              </div>
              <span className="thermo2-badge" style={{ color: col, borderColor: col }}>
                {c.stat === 'BARATO' ? '❄ BARATO' : c.stat === 'CARO' ? '🔥 CARO' : '• NEUTRO'}
              </span>
            </div>
          );
        })}
        {!coins.length && <div className="muted center">Cargando…</div>}
      </div>
    </Panel>
  );
}
