import React, { useEffect, useState } from 'react';

const COLORS = ['#00ff9d', '#00e5ff', '#ff2e88', '#ffe600', '#ff8a00', '#a259ff', '#4dffb8', '#ff4d4d'];

export default function Donut({ holdings, total }: { holdings: any[]; total: number }) {
  const [ready, setReady] = useState(false);
  // Dependencia estable: solo re-anima si CAMBIAN los datos (no en cada poll).
  const signature = holdings.map((h) => `${h.currency}:${h.valueMxn}`).join('|');
  useEffect(() => {
    setReady(false);
    const t = setTimeout(() => setReady(true), 80);
    return () => clearTimeout(t);
  }, [signature]);

  const sum = holdings.reduce((s, h) => s + Number(h.valueMxn || 0), 0) || 1;
  const r = 38;
  const C = 2 * Math.PI * r;
  let acc = 0;
  const slices = holdings.slice(0, 8).map((h, i) => {
    const frac = Number(h.valueMxn || 0) / sum;
    const len = frac * C;
    const off = -acc;
    acc += len;
    return { color: COLORS[i % COLORS.length], len, off, holding: h };
  });

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 100 100" className="donut">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#0a0a14" strokeWidth="16" />
        {slices.map((s, i) => (
          <circle
            key={s.holding.currency}
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth="16"
            strokeDasharray={ready ? `${s.len} ${C - s.len}` : `0 ${C}`}
            strokeDashoffset={s.off}
            transform="rotate(-90 50 50)"
            className="donut-slice"
            style={{ transitionDelay: `${i * 0.09}s` }}
          />
        ))}
        <text x="50" y="47" className="donut-total">
          ${Math.round(Number(total) || 0).toLocaleString('es-MX')}
        </text>
        <text x="50" y="58" className="donut-sub">
          {holdings.length} activos
        </text>
      </svg>
      <div className="donut-legend">
        {slices.map((s) => (
          <div className="donut-leg" key={s.holding.currency}>
            <span className="donut-dot" style={{ background: s.color }} />
            <b>{String(s.holding.currency).toUpperCase()}</b>
            <span className="muted">
              ${Number(s.holding.valueMxn).toFixed(2)} · {((Number(s.holding.valueMxn) / sum) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
