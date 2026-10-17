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
    <Panel title="◈ GANANCIAS A BUEN RECAUDO 🦀💰">
      <div className="pot-wrap">
        {/* Don Cangrejo abrazando la ganancia */}
        <div className={`vault-gif-wrap ${near ? 'near' : ''}`}>
          <img src="/vault.gif" alt="Don Cangrejo abrazando dinero" className="vault-gif" />
        </div>

        {/* Datos */}
        <div className="pot-info">
          <div>
            <span className="muted">GANANCIA GUARDADA (ya es tuya) 🔒</span>
            <b className={vault > 0 ? 'vault-pos' : ''}>${vault.toFixed(2)}</b>
            <span className="muted">de ${goal}</span>
          </div>
          <div>
            <span className="muted">GANANCIA FLOTANDO (de papel) 🎈</span>
            <b className={Number(d.floating ?? 0) > 0 ? 'vault-pos' : 'muted'}>
              ${Number(d.floating ?? 0).toFixed(2)}
            </b>
          </div>
          <div>
            <span className="muted">GANANCIA DE POR VIDA 💰</span>
            <b>${earned.toFixed(2)}</b>
          </div>
          <div>
            <span className="muted">GANANCIA YA COBRADA 🏦</span>
            <b>${withdrawn.toFixed(2)}</b>
          </div>
          <div className="pot-progress">{pct.toFixed(0)}% · faltan ${Math.max(0, goal - vault).toFixed(2)} de ganancia para el viaje a tu CLABE</div>
        </div>
      </div>

      <div className="vault-help">
        Aquí <b>solo entra ganancia</b>: tu dinero jamás se toca. Don Cangrejo no suelta ni un centavo hasta
        juntar <b>$50</b>… y entonces se van solitos por <b>SPEI</b> a tu CLABE. 🦀💸
      </div>
    </Panel>
  );
}
