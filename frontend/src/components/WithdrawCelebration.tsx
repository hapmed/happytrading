import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { sfxWithdraw } from '../lib/sfx';

/**
 * Celebración a pantalla completa cuando se transfiere una ganancia a tu CLABE.
 * Animación 8-bit (lluvia de monedas, destello, mascota) + fanfarria.
 */
export default function WithdrawCelebration() {
  const [event, setEvent] = useState<{ amount: number; bank: string } | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);

  useEffect(() => {
    const load = () =>
      api('/me/movements')
        .then((d: any) => {
          const rows = (d?.recorded ?? []) as any[];
          for (const w of rows) {
            if (w.kind !== 'WITHDRAWAL') continue;
            if (seen.current.has(w.id)) continue;
            seen.current.add(w.id);
            if (first.current) continue; // no celebrar los retiros viejos al abrir
            setEvent({ amount: Number(w.amount) || 0, bank: 'SPEI' });
            sfxWithdraw();
            window.setTimeout(() => setEvent(null), 9000);
          }
          first.current = false;
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (!event) return null;

  return (
    <div className="wd-overlay">
      <div className="wd-flash" />
      <div className="wd-card">
        <div className="wd-title">¡RETIRO ENVIADO!</div>
        <div className="wd-amount">${event.amount.toFixed(2)}</div>
        <div className="wd-sub">MXN → TU CLABE · {event.bank.toUpperCase()}</div>
        <div className="wd-mascot">🤑</div>
        <div className="wd-tag">GANANCIA TRANSFERIDA ✔</div>
      </div>
      {Array.from({ length: 28 }).map((_, i) => (
        <span
          key={i}
          className="wd-coin"
          style={{ left: `${(i * 3.7 + 2) % 100}%`, animationDelay: `${(i % 9) * 0.28}s`, fontSize: `${18 + (i % 4) * 6}px` }}
        >
          {i % 3 === 0 ? '💵' : i % 3 === 1 ? '🪙' : '💰'}
        </span>
      ))}
    </div>
  );
}
