import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Panel, PixelButton } from './Retro';

const STATE_LABEL: Record<string, string> = {
  idle: 'EN ESPERA',
  reading_balance: 'LEYENDO MERCADO',
  ai_thinking: 'IA PENSANDO',
  placing_order: '¡OPERANDO!',
  done: 'LISTO',
  error: 'ERROR',
};

export default function BotActivity() {
  const [data, setData] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [frame, setFrame] = useState(0);
  const consoleRef = useRef<HTMLDivElement>(null);

  const load = () =>
    api('/me/activity')
      .then((d) => setData(d))
      .catch(() => {});

  useEffect(() => {
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const state: string = data?.state ?? 'idle';
  const aiWorking = state === 'ai_thinking';
  const botWorking = ['reading_balance', 'ai_thinking', 'placing_order'].includes(state);

  useEffect(() => {
    const speed = botWorking ? 130 : 600;
    const id = setInterval(() => setFrame((f) => f + 1), speed);
    return () => clearInterval(id);
  }, [botWorking]);

  const ROBOT_WORK = [
`     ✳
╭─────────╮
│ ◉     ◉ │
│   ╰▽▽▽╯ │
╰──┬───┬──╯
╭──┴───┴──╮
│░✳░✳░✳░✳░│
╰─────────╯`,
`     ✳
╭─────────╮
│ ◉     ◉ │
│   ╰▽▽▽╯ │
╰──┬───┬──╯
╭──┴───┴──╮
│✳░✳░✳░✳░✳│
╰─────────╯`,
`     ✳
╭─────────╮
│  ◉   ◉  │
│   ╰▽▽▽╯ │
╰──┬───┬──╯
╭──┴───┴──╮
│░✳░✳░✳░✳░│
╰─────────╯`,
  ];
  const ROBOT_IDLE = [
`     ✳
╭─────────╮
│ ◉     ◉ │
│   ╰───╯ │
╰──┬───┬──╯
╭──┴───┴──╮
│░░░░░░░░░│
╰─────────╯`,
`     ✳
╭─────────╮
│ ─     ─ │
│   ╰───╯ │
╰──┬───┬──╯
╭──┴───┴──╮
│░░░░░░░░░│
╰─────────╯`,
  ];
  const robotArt = (botWorking ? ROBOT_WORK : ROBOT_IDLE)[frame % (botWorking ? 3 : 2)];
  const botAlive = !!data?.botAlive;
  const events: any[] = data?.events ?? [];

  const intervalMs: number = data?.intervalMs ?? 300000;
  const lastPassAtMs: number | null = data?.lastPassAtMs ?? null;
  const elapsed = lastPassAtMs ? now - lastPassAtMs : 0;
  const remainingMs = Math.max(0, intervalMs - elapsed);
  const progress = Math.min(100, intervalMs > 0 ? (elapsed / intervalMs) * 100 : 0);
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);

  const runNow = async () => {
    setRunning(true);
    try {
      await api('/me/run', { method: 'POST' });
    } catch {}
    setTimeout(() => {
      load();
      setRunning(false);
    }, 1500);
  };

  return (
    <Panel title="◈ CENTRO DE ACTIVIDAD" className="activity-panel">
      <div className="act-status-row">
        <div className="act-module app online">
          <span className="led" />
          <b>APP</b>
          <small>ONLINE</small>
        </div>
        <div className={`act-module bot ${botWorking ? 'working' : botAlive ? 'alive' : 'off'}`}>
          <span className="led" />
          <b>BOT</b>
          <small>{botWorking ? 'TRABAJANDO' : botAlive ? 'ACTIVO' : 'OFFLINE'}</small>
        </div>
        <div className={`act-module ai ${aiWorking ? 'working' : ''}`}>
          <span className="led" />
          <b>IA</b>
          <small>{aiWorking ? 'PENSANDO' : 'REPOSO'}</small>
        </div>
        <div style={{ flex: 1 }} />
        <PixelButton variant="primary" onClick={runNow} disabled={running}>
          {running ? '◌ EJECUTANDO...' : '▶ EJECUTAR AHORA'}
        </PixelButton>
      </div>

      <div className="next-run">
        <div className="next-label">
          {botWorking
            ? '◌ IA TRABAJANDO AHORA...'
            : `◌ PRÓXIMA PASADA DEL BOT EN ${mm}:${ss.toString().padStart(2, '0')}`}
        </div>
        <div className={`progress ${botWorking ? 'busy' : ''}`}>
          <div className="progress-fill" style={botWorking ? undefined : { width: `${progress}%` }} />
        </div>
      </div>

      <div className={`act-stage ${botWorking ? 'busy' : ''}`}>
        <pre className={`ascii-robot ${botWorking ? 'busy' : ''}`}>{robotArt}</pre>
        <div className="act-eq">
          {Array.from({ length: 11 }).map((_, i) => (
            <span key={i} style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
        </div>
        <div className="act-msg">
          {STATE_LABEL[state] ?? state}
          {data?.symbol ? ` · ${data.symbol}` : ''}
          <span className="cursor" />
        </div>
      </div>

      <div className="console" ref={consoleRef}>
        {events.length === 0 && (
          <div className="console-line muted">
            Sin actividad todavía. Pulsa ▶ EJECUTAR AHORA para ver al bot en acción.
          </div>
        )}
        {events.map((e, i) => (
          <div key={i} className={`console-line ${e.level}`}>
            <span className="ts">{new Date(e.t).toLocaleTimeString()}</span> {e.message}
          </div>
        ))}
      </div>
    </Panel>
  );
}
