import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

interface Card {
  id: string;
  emoji: string;
  title: string;
  text: string;
  mood: string;
}

export default function Drama() {
  const [cards, setCards] = useState<Card[]>([]);

  useEffect(() => {
    const load = () =>
      api('/me/drama')
        .then((d: any) => setCards(d?.cards ?? []))
        .catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <Panel title="📺 ¿QUÉ ONDA CON MI DINERO?">
      <p className="muted mb" style={{ fontSize: 16 }}>
        El <b>chismógrafo</b> del bot: te explica con humor cuando pasan cosas raras
        (y por qué <b>casi nunca</b> son pérdidas de verdad).
      </p>
      <div className="drama-list">
        {cards.map((c) => (
          <div className={`drama-card drama-${c.mood}`} key={c.id}>
            <div className="drama-emoji">{c.emoji}</div>
            <div style={{ minWidth: 0 }}>
              <div className="drama-title">{c.title}</div>
              <div className="drama-text">{c.text}</div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
