import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Panel, Stat } from './Retro';
import { pickLine } from '../lib/wolfLines';
import { sfxChaChing } from '../lib/sfx';
import Donut from './Donut';

function fmt(n: number) {
  return n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function useCountUp(target: number, duration = 900) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const a = fromRef.current;
    const b = target;
    if (a === b) return;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = b;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function CoinRain({ n }: { n: number }) {
  return (
    <div className="coin-rain" key={n}>
      {Array.from({ length: 22 }).map((_, i) => (
        <span key={i} style={{ left: `${(i * 5.3) % 100}%`, animationDelay: `${(i % 8) * 0.12}s` }}>
          {i % 3 === 0 ? '🪙' : i % 3 === 1 ? '💰' : '✨'}
        </span>
      ))}
    </div>
  );
}

function Chart({ data, baseline }: { data: { t: string; v: number }[]; baseline: number }) {
  const w = 620;
  const h = 220;
  const pad = 26;
  if (data.length < 2) {
    return (
      <div className="muted center" style={{ padding: 34 }}>
        ◌ RECOLECTANDO DATOS...
        <br />
        El gráfico se dibuja con cada pasada del bot. Pulsa ▶ EJECUTAR AHORA para añadir puntos.
      </div>
    );
  }
  const vs = data.map((d) => d.v);
  const min = Math.min(...vs, baseline > 0 ? baseline : Math.min(...vs));
  const max = Math.max(...vs, baseline > 0 ? baseline : Math.max(...vs));
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / range) * (h - 2 * pad);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const baseY = baseline > 0 ? y(baseline) : null;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" preserveAspectRatio="none">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00ff9d" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#00ff9d" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((p) => (
        <line key={p} x1={pad} x2={w - pad} y1={pad + p * (h - 2 * pad)} y2={pad + p * (h - 2 * pad)} stroke="#1c1c38" strokeWidth="1" />
      ))}
      <path d={area} fill="url(#areaGrad)" />
      <path d={line} fill="none" stroke="#00ff9d" strokeWidth="3" className="chart-line" />
      {baseY != null && (
        <line x1={pad} x2={w - pad} y1={baseY} y2={baseY} stroke="#ffe600" strokeWidth="2" strokeDasharray="7 7" />
      )}
    </svg>
  );
}

export default function Portfolio() {
  const [data, setData] = useState<any>(null);
  const [rain, setRain] = useState(0);
  const [flash, setFlash] = useState('');
  const [line, setLine] = useState('');
  const prevPnl = useRef<number | null>(null);

  const load = () => api('/me/portfolio').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data) return;
    const p = Number(data.pnl ?? 0);
    if (prevPnl.current != null && p > prevPnl.current + 0.001) {
      setRain((r) => r + 1);
      setFlash('flash-up');
      sfxChaChing();
      setTimeout(() => setFlash(''), 1500);
    }
    prevPnl.current = p;
  }, [data]);

  const invested = Number(data?.invested ?? 0);
  const current = Number(data?.currentValue ?? 0);
  const pnl = Number(data?.pnl ?? 0);
  const pnlPct = Number(data?.pnlPct ?? 0);
  const holdings: any[] = data?.holdings ?? [];
  const history: { t: string; v: number }[] = data?.history ?? [];
  const gain = pnl >= 0;
  const hasData = data && (current > 0 || history.length > 0);

  const aPnl = useCountUp(pnl);
  const aCur = useCountUp(current);
  const aInv = useCountUp(invested);

  useEffect(() => {
    const set = () => setLine(pickLine(gain ? 'profit' : 'loss'));
    set();
    const id = setInterval(set, 6000);
    return () => clearInterval(id);
  }, [gain]);

  const maxHolding = holdings.reduce((m, h) => Math.max(m, Number(h.valueMxn) || 0), 0) || 1;

  return (
    <>
      <Panel title="◈ TU DINERO" className={`pnl-panel ${flash}`}>
        <div className="live-row">
          <span className="live-dot" /> EN VIVO · PRECIOS AL MOMENTO
        </div>
        <div className={`pnl-hero ${gain ? 'gain' : 'loss'}`}>
          <div className="pnl-wolf">
            <img src="/wolf.png" alt="El Lobo" className="wolf-img" />
          </div>
          <div className="pnl-info">
            <div className="pnl-label">{gain ? '▲ GANANCIA TOTAL' : '▼ PÉRDIDA TOTAL'}</div>
            <div className="pnl-value">
              {gain ? '+' : '−'}${fmt(Math.abs(aPnl))}
            </div>
            <div className="pnl-pct">
              {pnlPct >= 0 ? '+' : ''}
              {pnlPct.toFixed(2)}%
            </div>
            <div className="pnl-phrase">“{line}”</div>
          </div>
          {rain > 0 && <CoinRain n={rain} />}
        </div>

        <div className="stat-grid" style={{ marginTop: 14, marginBottom: 0 }}>
          <Stat label="INVERTIDO" value={`$${fmt(aInv)}`} accent="yellow" />
          <Stat label="VALOR ACTUAL" value={`$${fmt(aCur)}`} accent="cyan" />
          <Stat label={gain ? 'GANANCIA' : 'PÉRDIDA'} value={`$${fmt(Math.abs(pnl))}`} accent={gain ? 'green' : 'red'} />
          <Stat label="DEPÓSITOS" value={`$${fmt(Number(data?.netDeposits ?? 0))}`} accent="yellow" />
        </div>
        <div className="muted center" style={{ marginTop: 8, fontSize: 15 }}>
          Los <b>depósitos por transferencia</b> no cuentan como ganancia.
        </div>

        {!hasData && (
          <div className="muted center" style={{ marginTop: 12 }}>
            Conecta tu Bitso y pulsa ▶ EJECUTAR AHORA para empezar a ver tus ganancias.
          </div>
        )}
      </Panel>

      <Panel title="◈ VALOR DEL PORTAFOLIO (MXN)">
        <Chart data={history} baseline={invested} />
        {invested > 0 && (
          <div className="muted center" style={{ marginTop: 6, fontFamily: 'var(--font-pixel)', fontSize: 8 }}>
            ─ ─ LÍNEA AMARILLA = TU INVERSIÓN INICIAL
          </div>
        )}
      </Panel>

      <Panel title="◈ TUS CRIPTOS">
        {holdings.length === 0 ? (
          <div className="muted center">Aún sin datos de portafolio.</div>
        ) : (
          <Donut holdings={holdings} total={current} />
        )}
      </Panel>
    </>
  );
}
