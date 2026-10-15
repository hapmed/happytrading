import React, { useEffect, useMemo, useState } from 'react';
import { Panel } from './Retro';

// ===== Personajes 8-bit inspirados en "El Lobo de Wall Street" (fan-art) =====
const PX = 6;

const PALETTE: Record<string, string> = {
  h: '#3a2410', // cabello oscuro
  y: '#e8c14a', // rubio
  z: '#2b2b33', // cabello/negro gris
  k: '#e8b48a', // piel
  s: '#1b2a4a', // traje azul marino
  g: '#6b7280', // traje gris
  l: '#cbb27a', // traje claro
  w: '#e9edf5', // camisa blanca
  t: '#c81e3a', // corbata roja
  b: '#111318', // zapatos
  p: '#e0447f', // vestido rosa
};

interface CharCfg {
  key: string;
  name: string;
  grid: string[];
  eyeY: number;
  eyeX1: number;
  eyeX2: number;
  mouthY: number;
  mouthX: number;
  glasses?: boolean;
  lines: string[];
}

const CHARS: CharCfg[] = [
  {
    key: 'lobo',
    name: 'EL LOBO',
    eyeY: 4, eyeX1: 4, eyeX2: 7, mouthY: 6, mouthX: 5,
    lines: ['¡MÁS ES MÁS!', '¡EL SHOW SIGUE!', 'VÉNDEME ESTE BOLÍGRAFO', '¡QUÍMICA!'],
    grid: [
      '....hhhh....',
      '...hhhhhh...',
      '..hhhhhhhh..',
      '..hkkkkkkh..',
      '..hkkkkkkh..',
      '..hkkkkkkh..',
      '...kkkkkk...',
      '....kkkk....',
      '..sswwwwss..',
      '.ssswwwwsss.',
      '.ssswttwsss.',
      '.ssswttwsss.',
      '.ssswwwwsss.',
      '.ssss..ssss.',
      '.ssss..ssss.',
      '..bb....bb..',
    ],
  },
  {
    key: 'socio',
    name: 'EL SOCIO',
    eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5,
    lines: ['¿QUÍMICA?', '¡ESTAMOS FORRADOS!', '¡COMPRA YA!', '¡JAJAJA!'],
    grid: [
      '...yyyyyy...',
      '..yyyyyyyy..',
      '.yykkkkkkyy.',
      '.yykkkkkkyy.',
      '.ykkkkkkkky.',
      '..kkkkkkkk..',
      '....kkkk....',
      '..llwwwwll..',
      '.lllwwwwlll.',
      '.lllwttwlll.',
      '.lllwttwlll.',
      '.lllwwwwlll.',
      '.llll..llll.',
      '.llll..llll.',
      '..bb....bb..',
    ],
  },
  {
    key: 'mentor',
    name: 'EL MENTOR',
    eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5, glasses: true,
    lines: ['NO ES REAL HASTA QUE LO VENDES', 'RELAJA EL CUERPO', 'TÓMATE UN MARTINI'],
    grid: [
      '....kkkk....',
      '...kkkkkk...',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '...kkkkkk...',
      '....kkkk....',
      '..ggwwwwgg..',
      '.gggwwwwggg.',
      '.gggwttwggg.',
      '.gggwwwwggg.',
      '.gggg..gggg.',
      '.gggg..gggg.',
      '..bb....bb..',
    ],
  },
  {
    key: 'novia',
    name: 'LA NOVIA',
    eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5,
    lines: ['¿MÁS ZAPATOS?', 'TE DIJE QUE LO DEJARAS', 'SUBE, SUBE 📈'],
    grid: [
      '..yyyyyyyy..',
      '.yyyyyyyyyy.',
      '.yykkkkkkyy.',
      '.yykkkkkkyy.',
      '.yykkkkkkyy.',
      '..ykkkkkky..',
      '...kkkkkk...',
      '....kkkk....',
      '..pppppppp..',
      '.pppppppppp.',
      '.pppppppppp.',
      '..pppppppp..',
      '..ppp..ppp..',
      '..bb....bb..',
    ],
  },
  {
    key: 'agente',
    name: 'EL AGENTE',
    eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5,
    lines: ['TE ESTOY VIGILANDO', '¿DE DÓNDE SALIÓ ESO?', 'NO TAN RÁPIDO'],
    grid: [
      '...zzzzzz...',
      '..zzzzzzzz..',
      '.zzkkkkkkzz.',
      '.zzkkkkkkzz.',
      '.zkkkkkkkkz.',
      '..kkkkkkkk..',
      '....kkkk....',
      '..zzwwwwzz..',
      '.zzzwwwwzzz.',
      '.zzzwwwwzzz.',
      '.zzzzwwzzzz.',
      '.zzzzzzzzzz.',
      '.zzzz..zzzz.',
      '..bb....bb..',
    ],
  },
];

const Sprite = React.memo(function Sprite({ grid }: { grid: string[] }) {
  const rects: React.ReactNode[] = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const c = grid[y][x];
      if (c === '.') continue;
      rects.push(<rect key={`${x}-${y}`} x={x * PX} y={y * PX} width={PX} height={PX} fill={PALETTE[c] ?? '#fff'} />);
    }
  }
  return <>{rects}</>;
});

function Char({ cfg, mood }: { cfg: CharCfg; mood: string }) {
  const [blink, setBlink] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);

  useEffect(() => {
    const blinkId = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 140);
    }, 3000 + Math.random() * 3000);
    return () => clearInterval(blinkId);
  }, []);

  useEffect(() => {
    let t2: any;
    const speak = () => {
      setBubble(cfg.lines[Math.floor(Math.random() * cfg.lines.length)]);
      setTimeout(() => setBubble(null), 2600);
      t2 = setTimeout(speak, 7000 + Math.random() * 7000);
    };
    t2 = setTimeout(speak, 1500 + Math.random() * 4000);
    return () => clearTimeout(t2);
  }, [cfg.lines]);

  const eye = mood === 'bear' ? '#c81e3a' : '#111318';
  const w = 12 * PX;
  const h = cfg.grid.length * PX;

  return (
    <div className="wolf-char">
      {bubble && <div className="wolf-bubble">{bubble}</div>}
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={`wolf-svg mood-${mood}`} shapeRendering="crispEdges">
        <Sprite grid={cfg.grid} />
        {!blink && (
          <>
            <rect x={cfg.eyeX1 * PX} y={cfg.eyeY * PX} width={PX} height={PX} fill={eye} />
            <rect x={cfg.eyeX2 * PX} y={cfg.eyeY * PX} width={PX} height={PX} fill={eye} />
          </>
        )}
        {cfg.glasses && <rect x={cfg.eyeX1 * PX} y={(cfg.eyeY - 1) * PX} width={PX * 4} height={PX} fill="#20242c" opacity={0.85} />}
        {mood === 'bull' ? (
          <rect x={(cfg.mouthX - 1) * PX} y={cfg.mouthY * PX} width={PX * 3} height={PX} fill="#111318" />
        ) : mood === 'bear' ? (
          <rect x={(cfg.mouthX + 1) * PX} y={(cfg.mouthY + 1) * PX} width={PX} height={PX} fill="#111318" />
        ) : (
          <rect x={cfg.mouthX * PX} y={cfg.mouthY * PX} width={PX} height={PX} fill="#111318" />
        )}
      </svg>
      <div className="wolf-name">{cfg.name}</div>
    </div>
  );
}

export default function TradingRoom() {
  const [zone, setZone] = useState('NEUTRAL');

  useEffect(() => {
    const load = () => fetch('/api/me/regime', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
      .then((r) => r.json())
      .then((d) => d?.zone && setZone(d.zone))
      .catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  const mood = zone === 'RISK_ON' ? 'bull' : zone === 'RISK_OFF' ? 'bear' : 'idle';

  return (
    <Panel title="🐺 SALA DE TRADING (8-BIT)" className="wolf-panel">
      <div className="wolf-stage">
        {CHARS.map((c) => (
          <Char key={c.key} cfg={c} mood={mood} />
        ))}
      </div>
      <div className="muted center" style={{ fontSize: 14, marginTop: 10 }}>
        Mercado: <b>{zone}</b> · personajes inspirados (fan-art). Cuando el mercado es RISK-ON festejan 🎉; en RISK-OFF se preocupan 😰.
      </div>
    </Panel>
  );
}
