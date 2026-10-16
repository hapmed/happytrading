import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

/**
 * Panel de ACCIONES (Alpaca) — estado de la cuenta en USD.
 * Solo aparece si Alpaca está configurado.
 */
export default function StocksPanel() {
  const [d, setD] = useState<any>(null);

  useEffect(() => {
    const load = () => api('/me/alpaca').then(setD).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  if (!d?.account) return null;

  const a = d.account;
  const bp = Number(a.buying_power ?? 0);
  const positions: any[] = d.positions ?? [];

  return (
    <Panel title="◈ ACCIONES (ALPACA)">
      <div className="payout-grid">
        <div className="payout-stat">
          <span className="muted">EFECTIVO (USD)</span>
          <b>${Number(a.cash ?? 0).toFixed(2)}</b>
        </div>
        <div className="payout-stat">
          <span className="muted">PODER DE COMPRA</span>
          <b>${bp.toFixed(2)}</b>
        </div>
        <div className="payout-stat">
          <span className="muted">VALOR PORTAFOLIO</span>
          <b>${Number(a.portfolio_value ?? 0).toFixed(2)}</b>
        </div>
        <div className="payout-stat">
          <span className="muted">MERCADO (EE.UU.)</span>
          <b>{d.clock?.is_open ? 'ABIERTO' : 'CERRADO'}</b>
        </div>
      </div>

      {bp <= 0 && (
        <div className="bitso-warn">
          ⚠ Tu cuenta Alpaca está en <b>{d.live ? 'LIVE (dinero real)' : 'Paper'}</b> pero con <b>$0</b>.{' '}
          {d.depositAddress ? (
            <>
              Fóndela enviando <b>{d.depositAsset}</b> a esta dirección (red <b>Ethereum / ERC-20</b>):
              <div className="payout-clabe" style={{ fontSize: 15, wordBreak: 'break-all' }}>
                {d.depositAddress}
              </div>
            </>
          ) : (
            'Fóndela en USD para operar.'
          )}
        </div>
      )}

      {positions.length > 0 && (
        <div className="stat-grid" style={{ marginTop: 10 }}>
          {positions.map((p) => (
            <div className="payout-stat" key={p.symbol}>
              <span className="muted">{p.symbol}</span>
              <b>${Number(p.market_value ?? 0).toFixed(2)}</b>
              <span className={`thermo-num ${Number(p.unrealized_plpc ?? 0) >= 0 ? 'payout-pos' : ''}`}>
                {Number(p.unrealized_plpc ?? 0) * 100 >= 0 ? '+' : ''}
                {(Number(p.unrealized_plpc ?? 0) * 100).toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="payout-help">
        Cuenta <b>{d.live ? 'LIVE (dinero real)' : 'Paper (pruebas)'}</b> · moneda USD · estado <b>{a.status}</b>.
        {' '}El mercado de EE.UU. opera L-V 9:30–16:00 ET. (Bitso no expone acciones por API; Alpaca es aparte.)
      </div>
    </Panel>
  );
}
