import React, { useEffect, useState } from 'react';
import { WOLF, Sprite, Face, useBlink, PX } from './wolfSprite';

// Frases icónicas (inspiradas en la película) + inventadas hilarantes
const LINES: Record<string, string[]> = {
  profit: [
    '¡EL SHOW SIGUE! 🚀',
    '¡MÁS ES MÁS!',
    '¡ESTAMOS FORRADOS! 💸',
    '¿QUÍMICA? ¡DE LA BUENA!',
    'MI YATE NO SE PAGA SOLO 🛥️',
    '¡VÉNDEME ESTE BOLÍGRAFO!',
    'EL MERCADO ME AMA',
    '¿ALGUIEN DIJO MARTINI? 🍸',
    'IMPRIMIENDO DINERO 🖨️',
    '¡ESTO ES MEJOR QUE EL SEXO... Y LAS DROGAS!',
  ],
  loss: [
    'NO ES REAL HASTA QUE LO VENDES 😅',
    'ESTOY BIEN... ESTOY BIEN 😰',
    'NECESITO QUÍMICA, MUCHA QUÍMICA',
    'EL SHOW SIGUE... CREO',
    'NO MIRES EL GRÁFICO 🙈',
    '¿QUIÉN VENDE? NADIE VENDE',
    'ES UNA OPORTUNIDAD... DICEN',
    'AGUANTA, ES SOLO UN BACHE',
    'RESPIRA... RES... PIRA 😮‍💨',
    '¿ALGUIEN TIENE UN MARTINI? 🍸',
  ],
  idle: [
    'VIGILANDO EL MERCADO 👀',
    'EL SHOW SIGUE',
    'ESPERANDO LA JUGADA',
    'AQUÍ NO PASA NADA... AÚN',
    'TÓMATE UN MARTINI 🍸',
    '¿COMPRAMOS O ESPERAMOS?',
    'EL S&P... DIGO, EL BTC, ESTÁ RARO',
    'MANTÉN LA CALMA Y COMPRA MÁS',
  ],
};

export default function WolfBuddy() {
  const [mood, setMood] = useState<'profit' | 'loss' | 'idle'>('idle');
  const [line, setLine] = useState('');
  const [show, setShow] = useState(false);
  const blink = useBlink();

  useEffect(() => {
    const load = async () => {
      const t = localStorage.getItem('token');
      if (!t) return;
      try {
        const [p, r] = await Promise.all([
          fetch('/api/me/portfolio', { headers: { Authorization: `Bearer ${t}` } }).then((x) => x.json()).catch(() => null),
          fetch('/api/me/regime', { headers: { Authorization: `Bearer ${t}` } }).then((x) => x.json()).catch(() => null),
        ]);
        const invested = Number(p?.invested ?? 0);
        const pnl = Number(p?.pnl ?? 0);
        if (invested > 0.01 && pnl > 0.01) setMood('profit');
        else if (invested > 0.01 && pnl < -0.01) setMood('loss');
        else setMood(r?.zone === 'RISK_OFF' ? 'loss' : 'idle');
      } catch {}
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let t: any;
    const speak = () => {
      const arr = LINES[mood] ?? LINES.idle;
      setLine(arr[Math.floor(Math.random() * arr.length)]);
      setShow(true);
      setTimeout(() => setShow(false), 3400);
      t = setTimeout(speak, 7500 + Math.random() * 6000);
    };
    const t0 = setTimeout(speak, 2200);
    return () => {
      clearTimeout(t0);
      clearTimeout(t);
    };
  }, [mood]);

  const W = 16 * PX;
  const H = WOLF.length * PX;

  return (
    <div className={`wolfbuddy mood-${mood}`}>
      {show && line && <div className="wolfbuddy-bubble">{line}</div>}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="wolfbuddy-svg" shapeRendering="crispEdges">
        <Sprite grid={WOLF} />
        <Face mood={mood} eyeY={5} eyeX1={6} eyeX2={9} mouthY={7} mouthX={7} blink={blink} />
      </svg>
    </div>
  );
}
