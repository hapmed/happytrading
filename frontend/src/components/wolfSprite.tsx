import React from 'react';

// ===== Pixel-art del lobo (mascota) — inspirado en "El Lobo de Wall Street" (fan-art) =====
export const PX = 6;

export const PALETTE: Record<string, string> = {
  h: '#3a2410',
  y: '#e8c14a',
  z: '#2b2b33',
  k: '#e8b48a',
  s: '#1b2a4a',
  g: '#6b7280',
  l: '#cbb27a',
  w: '#e9edf5',
  t: '#c81e3a',
  b: '#111318',
  p: '#e0447f',
};

export const WOLF = [
  '......hhhh......',
  '....hhhhhhhh....',
  '...hhhhhhhhhh...',
  '...hhhhhhhhhh...',
  '...hkkkkkkkkh...',
  '...hkkkkkkkkh...',
  '...hkkkkkkkkh...',
  '....kkkkkkkk....',
  '.....kkkkkk.....',
  '......kkkk......',
  '.....swwwws.....',
  '....swwwwwws....',
  '...sswwttwwss...',
  '...sswwttwwss...',
  '...sswwttwwss...',
  '...sswwwwwwss...',
  '...ssssssssss...',
  '...ssss..ssss...',
  '...ssss..ssss...',
  '...ssss..ssss...',
  '...bbbb..bbbb...',
];

export const Sprite = React.memo(function Sprite({ grid }: { grid: string[] }) {
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

export function Face({ mood, eyeY, eyeX1, eyeX2, mouthY, mouthX, blink }: any) {
  const eye = mood === 'bear' || mood === 'loss' ? '#c81e3a' : '#111318';
  return (
    <>
      {!blink && (
        <>
          <rect x={eyeX1 * PX} y={eyeY * PX} width={PX} height={PX} fill={eye} />
          <rect x={eyeX2 * PX} y={eyeY * PX} width={PX} height={PX} fill={eye} />
        </>
      )}
      {mood === 'bull' || mood === 'profit' ? (
        <rect x={(mouthX - 1) * PX} y={mouthY * PX} width={PX * 3} height={PX} fill="#111318" />
      ) : mood === 'bear' || mood === 'loss' ? (
        <rect x={(mouthX + 1) * PX} y={(mouthY + 1) * PX} width={PX} height={PX} fill="#111318" />
      ) : (
        <rect x={mouthX * PX} y={mouthY * PX} width={PX} height={PX} fill="#111318" />
      )}
    </>
  );
}

export function useBlink(): boolean {
  const [blink, setBlink] = React.useState(false);
  React.useEffect(() => {
    const id = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 130);
    }, 2800 + Math.random() * 2600);
    return () => clearInterval(id);
  }, []);
  return blink;
}

/** Mascota: el lobo completo, con moneda y salto. Reacciona al `mood`. */
export function WolfMascot({ mood, scale = 1.4 }: { mood: string; scale?: number }) {
  const blink = useBlink();
  const [hop, setHop] = React.useState(false);
  React.useEffect(() => {
    const id = setInterval(() => {
      setHop(true);
      setTimeout(() => setHop(false), 420);
    }, 4500 + Math.random() * 4000);
    return () => clearInterval(id);
  }, []);
  const W = 16 * PX;
  const H = WOLF.length * PX;
  return (
    <div className={`wolf-lead ${hop ? 'hop' : ''} mood-${mood}`}>
      <div className="wolf-coin">🪙</div>
      <svg width={Math.round(W * scale)} height={Math.round(H * scale)} viewBox={`0 0 ${W} ${H}`} className="wolf-svg-lead" shapeRendering="crispEdges">
        <Sprite grid={WOLF} />
        <Face mood={mood} eyeY={5} eyeX1={6} eyeX2={9} mouthY={7} mouthX={7} blink={blink} />
      </svg>
    </div>
  );
}
