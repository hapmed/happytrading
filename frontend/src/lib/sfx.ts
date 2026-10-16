// Sonidos 8-bit sintetizados (Web Audio), sin archivos.
let ctx: AudioContext | null = null;
let muted = typeof localStorage !== 'undefined' && localStorage.getItem('sfx') === 'off';

function ac(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function isMuted(): boolean {
  return muted;
}
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem('sfx', m ? 'off' : 'on');
  } catch {}
}

function tone(freq: number, dur: number, type: OscillatorType = 'square', when = 0, gain = 0.05): void {
  const a = ac();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  g.connect(a.destination);
  const t = a.currentTime + when;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** "coin": moneda (compras). */
export function sfxCoin(): void {
  if (muted) return;
  tone(880, 0.08);
  tone(1320, 0.1, 'square', 0.06);
}

/** "cha-ching": campanita (ganancia). */
export function sfxChaChing(): void {
  if (muted) return;
  tone(988, 0.1);
  tone(1319, 0.12, 'square', 0.08);
  tone(784, 0.14, 'square', 0.2);
  tone(1568, 0.22, 'square', 0.32);
}

export function sfxError(): void {
  if (muted) return;
  tone(220, 0.18, 'sawtooth');
  tone(160, 0.22, 'sawtooth', 0.12);
}

// Reanuda el audio en el primer gesto del usuario (política de autoplay).
if (typeof window !== 'undefined') {
  const resume = () => {
    try {
      ac();
    } catch {}
  };
  ['click', 'touchstart', 'keydown'].forEach((e) => window.addEventListener(e, resume, { once: true }));
}
