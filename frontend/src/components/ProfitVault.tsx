import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

/**
 * Bóveda de ganancias: cuánto se ha acumulado hacia el retiro automático de $50,
 * más el total histórico ganado y retirado.
 */
export default function ProfitVault() {
  const [d, setD] = useState<any>(null);

  useEffect(() => {
    const load = () => api('/me/vault').then(setD).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (!d) return null;

  const vault = Number(d.vault ?? 0);
  const goal = Number(d.goal ?? 50);
  const pct = Math.min(100, (vault / goal) * 100);
  const earned = Number(d.totalEarned ?? 0);
  const withdrawn = Number(d.totalWithdrawn ?? 0);

  return (
    <Panel title="◈ BÓVEDA DE GANANCIAS">
      <div className="vault-top">
        <div className="vault-big">
          <span className="muted">ACUMULADO (hacia el retiro de ${goal})</span>
          <b className={vault > 0 ? 'vault-pos' : ''}>${vault.toFixed(2)}</b>
        </div>
        <div className="vault-meta">
          <div>
            <span className="muted">TOTAL GANADO</span>
            <b>${earned.toFixed(2)}</b>
          </div>
          <div>
            <span className="muted">YA RETIRADO</span>
            <b>${withdrawn.toFixed(2)}</b>
          </div>
          <div>
            <span className="muted">CAPITAL</span>
            <b>${Number(d.invested ?? 0).toFixed(2)}</b>
          </div>
        </div>
      </div>

      <div className="vault-bar">
        <div className="vault-bar-fill" style={{ width: `${pct}%` }} />
        <span className="vault-bar-label">
          {pct.toFixed(0)}% · faltan ${Math.max(0, goal - vault).toFixed(2)} para el próximo retiro
        </span>
      </div>

      <div className="vault-foot">
        <div className="vault-help">
          Al llegar a <b>${goal}</b> se transfiere <b>solo</b> a tu CLABE (SPEI) y la bóveda se <b>reinicia a $0</b>.
          Cada retiro se celebra con 🎉 animación y sonido.
        </div>
      </div>
    </Panel>
  );
}
