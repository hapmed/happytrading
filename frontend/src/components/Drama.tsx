import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

/**
 * El bot explica, en español simple, POR QUÉ hizo lo que hizo:
 * qué compró/vendió, por qué, y qué espera que pase.
 */
export default function Drama() {
  const [text, setText] = useState('');

  useEffect(() => {
    const load = () =>
      api('/me/explain')
        .then((d: any) => setText(d?.text ?? ''))
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  // Resalta los nombres de monedas y los números para que se lea fácil.
  const pretty = (t: string) =>
    t
      .split(/(\b[A-Z]{2,6}\b|\+?\d+\.\d+%|−\d+\.\d+%)/g)
      .map((part, i) =>
        /^[A-Z]{2,6}$/.test(part) || /%$/.test(part) ? (
          <b className="explain-hl" key={i}>
            {part}
          </b>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      );

  return (
    <Panel title="◈ ¿QUÉ ONDA CON MI DINERO?">
      <p className="explain-text">{text ? pretty(text) : 'Consultando al cerebro del bot… 🧠'}</p>
    </Panel>
  );
}
