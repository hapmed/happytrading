import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Panel } from './Retro';

const LABELS: Record<string, string> = {
  reading_balance: 'OLIENDO EL MERCADO… 👃',
  ai_thinking: 'IA ESTRUJÁNDOSE EL CEREBRO… 🧠',
  placing_order: '¡APRETANDO EL BOTÓN! 🎯',
  idle: 'VIGILANDO COMO ÁGUILA 🦅',
  error: 'TROPEZÓ… PERO SE LEVANTA 🩹',
};

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${d > 0 ? `${d}d ` : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

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

  const uptime = user?.autoSince ? fmtDuration(now - new Date(user.autoSince).getTime()) : '—';
  const liveSec = user?.autoSince ? Math.max(0, Math.floor((now - new Date(user.autoSince).getTime()) / 1000)) : 0;
  const totalUptime = fmtDuration((Number(user?.autoTotalSec ?? 0) + liveSec) * 1000);

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
        <span className="livebar-title">CHAMBEANDO PARA TI · 24/7 🛠️</span>
        <span className="livebar-state">{alive ? LABELS[state] ?? state : 'RECONECTANDO… (se cayó el internet 📶)'}</span>
        <span className="livebar-eq">
          {Array.from({ length: 8 }).map((_, i) => (
            <i key={i} style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
        </span>
        <span className="livebar-next">otra vuelta en {remaining > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : '¡ya merito!'}</span>
      </div>

      <div className="uptime">
        ⏱ EN CHAMBA AHORA: <b>{uptime}</b> · SIN DORMIR EN TOTAL: <b>{totalUptime}</b>
      </div>

      

      <button type="button" className={`auto-banner ${on ? 'on' : 'off'}`} onClick={toggle} disabled={busy} style={{ marginBottom: 0 }}>
        <span className="auto-dot" />
        <div className="auto-text">
          <div className="auto-title">{on ? 'AUTO ENCENDIDO' : 'AUTO APAGADO'}</div>
          <div className="auto-sub">{on ? 'El bot compra y vende solo en Binance (ya sabe 😎)' : 'El bot está de brazos cruzados: no toca nada 🚫'}</div>
        </div>
        <div className="auto-switch">{on ? 'ON' : 'OFF'}</div>
      </button>
    </Panel>
  );
}
