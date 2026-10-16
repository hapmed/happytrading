import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Retro';

interface Point {
  t: string;
  v: number;
}

/**
 * BÓVEDA DE GANANCIAS: las ganancias se acumulan en pesos (el bot NO las reinvierte)
 * y se reinicia en cada retiro. Con gráfica de la evolución.
 */
export default function ProfitVault() {
  const [data, setData] = useState<any>(null);

  const load = () => api('/me/vault').then(setData).catch(() => {});

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  const vault = Number(data.vault ?? 0);
  const ready = Number(data.withdrawableNow ?? 0);
  const history: Point[] = data.history ?? [];
  const asset = String(data.vaultAsset ?? 'usdc').toUpperCase();
  const assetQty = Number(data.vaultQty ?? 0);
  const assetValue = Number(data.vaultValue ?? 0);

  // Gráfica SVG (área) de la ganancia acumulada.
  const W = 620;
  const H = 160;
  const vals = history.map((p) => Number(p.v));
  const max = Math.max(vault, ...vals, 1);
  const step = history.length > 1 ? W / (history.length - 1) : W;
  const path = history
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(H - (Number(p.v) / max) * H).toFixed(1)}`)
    .join(' ');
  const area = `${path} L ${W} ${H} L 0 ${H} Z`;

  return (
    <Panel title="◈ BÓVEDA DE GANANCIAS">
      <div className="vault-top">
        <div className="vault-big">
          <span className="muted">ACUMULADO (desde el último retiro)</span>
          <b className={vault > 0 ? 'vault-pos' : ''}>${vault.toFixed(2)}</b>
        </div>
        <div className="vault-meta">
          <div>
            <span className="muted">BÓVEDA ({asset})</span>
            <b>
              {assetQty.toFixed(2)} {asset} · ${assetValue.toFixed(2)}
            </b>
          </div>
          <div>
            <span className="muted">PUEDES RETIRAR AHORA</span>
            <b>${ready.toFixed(2)}</b>
          </div>
          <div>
            <span className="muted">CAPITAL INVERTIDO</span>
            <b>${Number(data.invested ?? 0).toFixed(2)}</b>
          </div>
          <div>
            <span className="muted">VALOR ACTUAL</span>
            <b>${Number(data.currentValue ?? 0).toFixed(2)}</b>
          </div>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="vault-chart" preserveAspectRatio="none">
        <defs>
          <linearGradient id="vaultFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--green)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#vaultFill)" />
        <path d={path} fill="none" stroke="var(--green)" strokeWidth="2" />
      </svg>

      <div className="vault-foot">
        <div className="vault-help">
          El bot mueve las ganancias a <b>{asset}</b> (moneda estable) y <b>no las opera</b>. En Binance puedes{' '}
          <b>vender {asset} → pesos</b> y retirar por SPEI. El retiro se <b>detecta automáticamente</b> y la bóveda se{' '}
          <b>reinicia a $0</b>. ✨
        </div>
      </div>
    </Panel>
  );
}
