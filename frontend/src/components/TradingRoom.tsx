import React, { useEffect, useState } from 'react';
import { Panel } from './Retro';
import { WOLF, Sprite, Face, useBlink, PX } from './wolfSprite';

interface CharCfg {
  key: string;
  grid: string[];
  eyeY: number;
  eyeX1: number;
  eyeX2: number;
  mouthY: number;
  mouthX: number;
  glasses?: boolean;
}

const CROWD: CharCfg[] = [
  {
    key: 'socio', eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5,
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
    key: 'mentor', eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5, glasses: true,
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
    key: 'novia', eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5,
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
    key: 'agente', eyeY: 3, eyeX1: 4, eyeX2: 7, mouthY: 5, mouthX: 5,
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

function WolfMascot({ mood }: { mood: string }) {
  const blink = useBlink();
  const [hop, setHop] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      setHop(true);
      setTimeout(() => setHop(false), 420);
    }, 5000 + Math.random() * 4500);
    return () => clearInterval(id);
  }, []);
  const W = 16 * PX;
  const H = WOLF.length * PX;
  return (
    <div className={`wolf-lead ${hop ? 'hop' : ''} mood-${mood}`}>
      <div className="wolf-coin">🪙</div>
      <svg width={Math.round(W * 1.5)} height={Math.round(H * 1.5)} viewBox={`0 0 ${W} ${H}`} className="wolf-svg-lead" shapeRendering="crispEdges">
        <Sprite grid={WOLF} />
        <Face mood={mood} eyeY={5} eyeX1={6} eyeX2={9} mouthY={7} mouthX={7} blink={blink} />
      </svg>
    </div>
  );
}

function Crowd({ cfg, mood }: { cfg: CharCfg; mood: string }) {
  const blink = useBlink();
  const W = 12 * PX;
  const H = cfg.grid.length * PX;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="wolf-svg" shapeRendering="crispEdges">
      <Sprite grid={cfg.grid} />
      <Face mood={mood} eyeY={cfg.eyeY} eyeX1={cfg.eyeX1} eyeX2={cfg.eyeX2} mouthY={cfg.mouthY} mouthX={cfg.mouthX} blink={blink} />
      {cfg.glasses && <rect x={cfg.eyeX1 * PX} y={(cfg.eyeY - 1) * PX} width={PX * 4} height={PX} fill="#20242c" opacity={0.85} />}
    </svg>
  );
}

export default function TradingRoom() {
  const [zone, setZone] = useState('NEUTRAL');

  useEffect(() => {
    const load = () =>
      fetch('/api/me/regime', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
        .then((r) => r.json())
        .then((d) => d?.zone && setZone(d.zone))
        .catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  const mood = zone === 'RISK_ON' ? 'bull' : zone === 'RISK_OFF' ? 'bear' : 'idle';

  return (
    <Panel title="🐺 SALA DE TRADING">
      <div className="wolf-stage">
        <WolfMascot mood={mood} />
        <div className="wolf-crowd">
          {CROWD.map((c) => (
            <Crowd key={c.key} cfg={c} mood={mood} />
          ))}
        </div>
      </div>
    </Panel>
  );
}
