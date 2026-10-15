import React, { useEffect, useState } from 'react';
import { pickLine } from '../lib/wolfLines';

export default function WolfBuddy() {
  const [mood, setMood] = useState<'profit' | 'loss' | 'idle'>('idle');
  const [line, setLine] = useState('');
  const [show, setShow] = useState(false);

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
      setLine(pickLine(mood));
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

  return (
    <div className={`wolfbuddy mood-${mood}`}>
      {show && line && <div className="wolfbuddy-bubble">{line}</div>}
      <img src="/wolf.png" alt="El Lobo" className="wolfbuddy-img" />
    </div>
  );
}
