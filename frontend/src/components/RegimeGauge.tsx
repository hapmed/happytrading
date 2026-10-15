import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

const ZONE_LABEL: Record<string, string> = {
  RISK_ON: 'RISK-ON',
  NEUTRAL: 'NEUTRAL',
  RISK_OFF: 'RISK-OFF',
};

export default function RegimeGauge() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const load = () => api('/me/regime').then(setData).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  const score = Number(data.score) || 0;
  const zone = data.zone;
  const cls = zone === 'RISK_ON' ? 'on' : zone === 'RISK_OFF' ? 'off' : 'mid';

  return (
    <Panel title="◈ RÉGIMEN DE MERCADO (CRIPTO)" className={`regime-panel ${cls}`}>
      <div className="regime-top">
        <div className={`regime-zone ${cls}`}>{ZONE_LABEL[zone] || zone}</div>
        <div className="regime-score">
          {score}
          <span>/100</span>
        </div>
      </div>

      <div className="regime-track">
        <div className="regime-needle" style={{ left: `${score}%` }} />
        <div className="regime-ticks">
          <span>0</span>
          <span>40</span>
          <span>80</span>
          <span>100</span>
        </div>
      </div>

      <div className="muted center" style={{ marginBottom: 16, fontSize: 16 }}>
        {data.guidance}
        {data.cached ? ' · caché' : ''}
      </div>

      <div className="regime-comps">
        {(data.components ?? []).map((c: any) => {
          const val = c.dataAvailable && c.score != null ? Number(c.score) : 0;
          return (
            <div className="regime-comp" key={c.key}>
              <div className="regime-comp-top">
                <b>{c.name}</b>
                <span>{c.dataAvailable && c.score != null ? c.score : '—'}</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${val}%` }} />
              </div>
              <small className="muted">{c.signal}</small>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
