import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Panel } from './Retro';

const LABELS: Record<string, string> = {
  reading_balance: 'LEYENDO EL MERCADO…',
  ai_thinking: 'IA ANALIZANDO…',
  placing_order: '¡OPERANDO!',
  idle: 'VIGILANDO EL MERCADO',
  error: 'RECUPERÁNDOSE…',
};

export default function StatusBox() {
  const { user, setUser } = useAuth();
  const [act, setAct] = useState<any>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  const on = !!user?.autoTrade;

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

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const u = await api('/me/trading', { method: 'PUT', body: JSON.stringify({ autoTrade: !on }) });
      setUser(u);
    } catch {}
    setBusy(false);
  };

  return (
    <Panel title="◈ ESTADO DEL BOT" className={`statuspanel ${on ? 'auto-on' : 'auto-off'}`}>
      <div className={`livebar ${alive ? 'on' : 'off'}`}>
        <span className="livebar-led" />
        <span className="livebar-title">TRABAJANDO PARA TI · 24/7</span>
        <span className="livebar-state">{alive ? LABELS[state] ?? state : 'RECONECTANDO…'}</span>
        <span className="livebar-eq">
          {Array.from({ length: 8 }).map((_, i) => (
            <i key={i} style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
        </span>
        <span className="livebar-next">próxima pasada {remaining > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : '¡ahora!'}</span>
      </div>

      <button type="button" className={`auto-banner ${on ? 'on' : 'off'}`} onClick={toggle} disabled={busy} style={{ marginBottom: 0 }}>
        <span className="auto-dot" />
        <div className="auto-text">
          <div className="auto-title">{on ? 'AUTO ACTIVADO' : 'AUTO DETENIDO'}</div>
          <div className="auto-sub">{on ? 'El bot opera automáticamente en Bitso' : 'El bot solo analiza, NO operará'}</div>
        </div>
        <div className="auto-switch">{on ? 'ON' : 'OFF'}</div>
      </button>
    </Panel>
  );
}
