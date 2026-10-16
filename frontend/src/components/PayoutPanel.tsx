import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

/**
 * Panel de ganancias / retiro al banco (Plan B).
 * Como Bitso no permite retiros por API en cuentas personales, la app calcula
 * la ganancia y te dice exactamente cuánto retirar y a qué CLABE.
 */
export default function PayoutPanel() {
  const [info, setInfo] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const load = () => api('/me/payout-info').then(setInfo).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  if (!info?.clabe) return null;

  const copy = () => {
    navigator.clipboard
      ?.writeText(info.clabe)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const profit = Number(info.profit ?? 0);
  const ready = Number(info.withdrawableNow ?? 0);
  const working = Number(info.workingCapital ?? 0);

  const markDone = async () => {
    try {
      await api('/me/deposits', {
        method: 'POST',
        body: JSON.stringify({ amount: ready, kind: 'WITHDRAWAL', note: 'retiro manual SPEI (bóveda de ganancias)' }),
      });
      setDone(true);
      const fresh = await api('/me/payout-info');
      setInfo(fresh);
    } catch {
      /* ignore */
    }
  };

  return (
    <Panel title="◈ GANANCIAS · RETIRAR AL BANCO">
      <div className="payout-grid">
        <div className="payout-stat">
          <span className="muted">GANANCIA (sobre tu capital)</span>
          <b className={profit > 0 ? 'payout-pos' : ''}>${profit.toFixed(2)}</b>
        </div>
        <div className="payout-stat">
          <span className="muted">LISTO PARA RETIRAR (caja MXN)</span>
          <b>${ready.toFixed(2)}</b>
        </div>
        <div className="payout-stat">
          <span className="muted">CAPITAL DE TRABAJO</span>
          <b>${working.toFixed(2)}</b>
        </div>
      </div>

      <div className="payout-dest">
        <div>
          <span className="muted">DESTINO (SPEI)</span>
          <div>
            <b>{info.beneficiary}</b> · {info.bank}
          </div>
          <div className="payout-clabe">{info.clabe}</div>
        </div>
        <button className="pixel-btn small" onClick={copy}>
          {copied ? '✔ COPIADA' : '📋 COPIAR CLABE'}
        </button>
        <button className="pixel-btn small" onClick={markDone} disabled={done || ready <= 0}>
          {done ? '✔ REGISTRADO' : `✔ YA RETIRÉ $${ready.toFixed(2)}`}
        </button>
      </div>

      <div className="payout-help">
        Para retirar: abre la <b>app de Bitso</b> → <b>Retirar</b> → <b>Pesos (SPEI)</b> → pega tu CLABE y retira{' '}
        <b>${ready.toFixed(2)}</b>. El bot sigue operando con tu capital de trabajo (${working.toFixed(2)}).
      </div>
    </Panel>
  );
}
