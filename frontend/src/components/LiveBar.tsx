import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

const LABELS: Record<string, string> = {
  reading_balance: 'LEYENDO EL MERCADO…',
  ai_thinking: 'IA ANALIZANDO…',
  placing_order: '¡OPERANDO!',
  idle: 'VIGILANDO EL MERCADO',
  error: 'RECUPERÁNDOSE…',
};

export default function LiveBar() {
  const [act, setAct] = useState<any>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const load = () => api('/me/activity').then(setAct).catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const alive = !!act?.botAlive;
  const state = act?.state ?? 'idle';
  const intervalMs = act?.intervalMs ?? 180000;
  const last = act?.lastPassAtMs ?? null;
  const remaining = last ? Math.max(0, intervalMs - (now - last)) : 0;
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);

  return (
    <div className={`livebar ${alive ? 'on' : 'off'}`}>
      <span className="livebar-led" />
      <span className="livebar-title">TRABAJANDO PARA TI · 24/7</span>
      <span className="livebar-state">{alive ? LABELS[state] ?? state : 'RECONECTANDO…'}</span>
      <span className="livebar-eq">
        {Array.from({ length: 8 }).map((_, i) => (
          <i key={i} style={{ animationDelay: `${i * 0.1}s` }} />
        ))}
      </span>
      <span className="livebar-next">
        próxima pasada {remaining > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : '¡ahora!'}
      </span>
    </div>
  );
}
