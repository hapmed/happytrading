import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

function level(pct: number) {
  return pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
}

/** Consumo de IA del día por proveedor, con barras animadas y latido "en vivo". */
export default function Usage() {
  const [data, setData] = useState<any>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const load = () => api('/me/usage').then(setData).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  // Latido visual (para que se note "vivo" aunque no haya llamadas)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1200);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  const provs = data.usage?.providers ?? {};
  const names: string[] = Object.keys(provs);
  if (!names.length) names.push('omniroute', 'gemini', 'openrouter');

  return (
    <Panel title="◈ IA · CONSUMO DE HOY (free tiers)">
      <div className="usage-live">
        <span className="usage-dot" /> <b>EN VIVO</b> · se actualiza cada 15s
      </div>

      {names.map((p) => {
        const u = provs[p] ?? { requests: 0, tokens: 0, errors: 0 };
        const l = data.limits?.[p] ?? {};
        const rPct = l.requestsPerDay ? Math.min(100, (u.requests / l.requestsPerDay) * 100) : 0;
        const tPct = l.tokensPerDay ? Math.min(100, (u.tokens / l.tokensPerDay) * 100) : 0;
        const errPct = u.requests ? Math.min(100, (u.errors / u.requests) * 100) : 0;
        return (
          <div className="usage-block" key={p}>
            <div className="holding-top">
              <b>{p.toUpperCase()}</b>
              <span>
                {u.requests} peticiones · {Number(u.tokens).toLocaleString('es-MX')} tokens
                {u.errors ? ` · ${u.errors} err` : ''}
              </span>
            </div>
            <div className="bar">
              <div className={`bar-fill usage-${level(rPct)} shimmer`} style={{ width: `${Math.max(rPct, 2)}%` }} />
            </div>
            {l.tokensPerDay ? (
              <div className="bar" style={{ marginTop: 4 }}>
                <div className={`bar-fill usage-${level(tPct)} shimmer`} style={{ width: `${Math.max(tPct, 2)}%` }} />
              </div>
            ) : null}
            {u.errors ? (
              <div className="bar" style={{ marginTop: 4 }}>
                <div className="bar-fill usage-red" style={{ width: `${Math.max(errPct, 2)}%` }} />
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="muted center" style={{ fontSize: 15, marginTop: 8 }}>
        Si un proveedor llega a su límite, el bot <b>salta al siguiente</b> (nunca se pasa del free tier).
      </div>
    </Panel>
  );
}
