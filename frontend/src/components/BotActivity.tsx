import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Panel, PixelButton } from './Retro';

// Frases hilarantes para mientras el bot calcula / espera su próxima pasada.
const FRASES = [
  'El bot está afilando el lápiz para calcular 📝',
  'Haciendo cuentas con los dedos 🧮',
  'Consultando la bola de cristal 🔮',
  'Oliendo gangas en el mercado 👃',
  'Espiando a las ballenas 🐋',
  'Soplando los dados 🎲',
  'Decidiendo si comprar o llorar 😅',
  'Viéndose si el mercado está de buenas o de lunes',
  'Calentando los tubos… 🔥',
  'Contando billetes imaginarios 💸',
  'Preguntándole a la IA si es broma 🤖',
  'Mirando el gráfico con un ojo cerrado 🙈',
  'Aceitando los engranes ⚙️',
  'Pensando en tacos mientras calcula 🌮',
  'Haciéndose el interesante 😎',
  'Esperando a que el mercado diga "va"',
  'Buscando el precio de la dignidad 📉',
  'Revisando si ya somos ricos… aún no 🫠',
];

export default function BotActivity() {
  const [data, setData] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [phrase, setPhrase] = useState('');
  const consoleRef = useRef<HTMLDivElement>(null);
  const lastKey = useRef('');
  const firstLoad = useRef(true);

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
  const botAlive = !!data?.botAlive;
  // El log viene del más nuevo al más viejo → lo mostramos cronológico (nuevo abajo).
  const events: any[] = [...(data?.events ?? [])].reverse();

  // Frase hilarante rotando (más seguido cuando está calculando).
  useEffect(() => {
    const pick = () => setPhrase(FRASES[Math.floor(Math.random() * FRASES.length)]);
    pick();
    const id = setInterval(pick, botWorking ? 5000 : 9000);
    return () => clearInterval(id);
  }, [botWorking]);

  // ── Timer de la próxima pasada ──
  const intervalMs: number = data?.intervalMs ?? 300000;
  const lastPassAtMs: number | null = data?.lastPassAtMs ?? null;
  const elapsed = lastPassAtMs ? now - lastPassAtMs : 0;
  const remainingMs = Math.max(0, intervalMs - elapsed);
  const progress = Math.min(100, intervalMs > 0 ? (elapsed / intervalMs) * 100 : 0);
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);

  // ── Autoscroll LENTO y suave hacia lo más nuevo ──
  const newest = events.length ? `${events[events.length - 1].t}|${events[events.length - 1].message}` : '';
  useEffect(() => {
    const el = consoleRef.current;
    if (!el || !newest || newest === lastKey.current) return;
    lastKey.current = newest;
    const from = el.scrollTop;
    const to = el.scrollHeight - el.clientHeight;
    const dist = to - from;
    if (Math.abs(dist) < 3) return;
    // Al abrir, salta directo al final; después se desliza lento.
    if (firstLoad.current) {
      firstLoad.current = false;
      el.scrollTop = to;
      return;
    }
    const dur = 2600;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.scrollTop = from + dist * e;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [newest]);

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
            ? '◌ IA CALCULANDO AHORA...'
            : `◌ PRÓXIMA PASADA DEL BOT EN ${mm}:${ss.toString().padStart(2, '0')}`}
        </div>
        <div className={`progress ${botWorking ? 'busy' : ''}`}>
          <div className="progress-fill" style={botWorking ? undefined : { width: `${progress}%` }} />
        </div>
        <div className="next-phrase">“{phrase}”</div>
      </div>

      <div className="console" ref={consoleRef}>
        {events.length === 0 && (
          <div className="console-line muted">
            Sin actividad todavía. Pulsa ▶ EJECUTAR AHORA para ver al bot en acción.
          </div>
        )}
        {events.map((e, i) => (
          <div key={`${e.t}-${i}`} className={`console-line ${e.level}`}>
            <span className="ts">{new Date(e.t).toLocaleTimeString()}</span> {e.message}
          </div>
        ))}
      </div>
    </Panel>
  );
}
