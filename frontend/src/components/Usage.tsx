import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

function level(pct: number) {
  return pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
}

export default function Usage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const load = () => api('/me/usage').then(setData).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  return (
    <Panel title="◈ IA · CONSUMO DE HOY (free tiers)">
      {['gemini', 'openrouter'].map((p) => {
        const u = data.usage?.providers?.[p] ?? { requests: 0, tokens: 0, errors: 0 };
        const l = data.limits?.[p] ?? { requestsPerDay: 0, tokensPerDay: 0 };
        const rPct = l.requestsPerDay ? Math.min(100, (u.requests / l.requestsPerDay) * 100) : 0;
        const tPct = l.tokensPerDay ? Math.min(100, (u.tokens / l.tokensPerDay) * 100) : 0;
        const q = p === 'openrouter' ? data.openrouterQuota : null;
        const usedPct = q && q.limit ? Math.min(100, ((q.limit - (q.remaining ?? 0)) / q.limit) * 100) : null;
        return (
          <div className="usage-block" key={p}>
            <div className="holding-top">
              <b>{p.toUpperCase()}</b>
              <span>
                {u.requests}/{l.requestsPerDay} peticiones · {Number(u.tokens).toLocaleString('es-MX')} tokens
              </span>
            </div>
            <div className="bar">
              <div className={`bar-fill usage-${level(rPct)}`} style={{ width: `${rPct}%` }} />
            </div>
            <div className="bar" style={{ marginTop: 4 }}>
              <div className={`bar-fill usage-${level(tPct)}`} style={{ width: `${tPct}%` }} />
            </div>
            <small className="muted">
              {q && q.limit != null ? (
                <>Restante REAL de la API: <b>{q.remaining}</b> / {q.limit} ({q.reset ?? 'diario'})</>
              ) : p === 'gemini' ? (
                <>Google NO expone la cuota restante por API — revisa Google AI Studio. Este es tu estimado.</>
              ) : (
                <>Restante real: no disponible (sin key o sin conexión).</>
              )}
            </small>
            {usedPct != null && (
              <div className="bar" style={{ marginTop: 4 }}>
                <div className={`bar-fill usage-${level(usedPct)}`} style={{ width: `${usedPct}%` }} />
              </div>
            )}
          </div>
        );
      })}
      <div className="muted center" style={{ fontSize: 15, marginTop: 8 }}>
        Si un proveedor llega a su límite, el bot <b>deja de usarlo</b> y sigue con el otro (o espera). Así no te pasas del free tier.
      </div>
    </Panel>
  );
}
