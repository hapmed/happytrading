import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

/**
 * BÓVEDA DE GANANCIAS — olla de dinero 8-bit que se llena hasta los $50.
 * Las ganancias se guardan en MXN (cartera Funding); al llegar a $50 se retiran a la CLABE.
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
  const pct = Math.min(100, Math.max(0, (vault / goal) * 100));
  const near = pct >= 80;
  const earned = Number(d.totalEarned ?? 0);
  const withdrawn = Number(d.totalWithdrawn ?? 0);

  return (
    <Panel title="◈ BÓVEDA DE GANANCIAS">
      <div className="pot-wrap">
        {/* Olla de dinero 8-bit */}
        <div className={`pot ${near ? 'near' : ''}`}>
          <div className="pot-gold" style={{ height: `${pct}%` }}>
            <div className="pot-shine" />
          </div>
          {/* línea del límite $50 */}
          <div className="pot-goal-line">
            <span>$50</span>
          </div>
          {/* monedas cayendo */}
          {Array.from({ length: 7 }).map((_, i) => (
            <span key={i} className="pot-drop" style={{ left: `${10 + i * 12}%`, animationDelay: `${i * 0.45}s` }}>
              {i % 2 ? '💰' : '🪙'}
            </span>
          ))}
          <div className="pot-label">${vault.toFixed(2)}</div>
        </div>

        {/* Datos */}
        <div className="pot-info">
          <div>
            <span className="muted">EN LA BÓVEDA (guardado, MXN)</span>
            <b className={vault > 0 ? 'vault-pos' : ''}>${vault.toFixed(2)}</b>
            <span className="muted">de ${goal}</span>
          </div>
          <div>
            <span className="muted">FLOTANTE (no realizado)</span>
            <b className={Number(d.floating ?? 0) > 0 ? 'vault-pos' : 'muted'}>
              ${Number(d.floating ?? 0).toFixed(2)}
            </b>
          </div>
          <div>
            <span className="muted">TOTAL GANADO</span>
            <b>${earned.toFixed(2)}</b>
          </div>
          <div>
            <span className="muted">YA RETIRADO</span>
            <b>${withdrawn.toFixed(2)}</b>
          </div>
          <div className="pot-progress">{pct.toFixed(0)}% · faltan ${Math.max(0, goal - vault).toFixed(2)}</div>
        </div>
      </div>

      <div className="vault-help">
        Las ganancias se guardan en <b>pesos</b> (cartera Funding, fuera del trading). Al llegar a <b>$50</b> se
        transfieren <b>solo</b> a tu CLABE (SPEI) y la olla se vacía. 🎉
      </div>
    </Panel>
  );
}
