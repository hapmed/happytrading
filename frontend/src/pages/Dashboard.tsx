import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Panel, Stat, PixelButton } from '../components/Retro';
import BotActivity from '../components/BotActivity';

export default function Dashboard() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api('/me/trades'), api('/me/signals')])
      .then(([t, s]) => {
        setTrades(t);
        setSignals(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!user?.hasBitso) return;
    api('/me/balance')
      .then((d) => setBalances(d.balances ?? []))
      .catch(() => {});
  }, [user?.hasBitso]);

  const buys = trades.filter((t) => t.side === 'BUY').length;
  const sells = trades.filter((t) => t.side === 'SELL').length;
  const aiTrades = trades.filter((t) => t.source === 'AI').length;

  return (
    <div>
      <div className="spread mb">
        <h2 style={{ fontFamily: 'var(--font-pixel)', fontSize: 14, color: 'var(--green)' }}>
          BIENVENIDO, {user?.name || user?.username || user?.email}
        </h2>
        <span className="floaty" style={{ fontSize: 26 }}>🪙</span>
      </div>

      <BotActivity />

      {!user?.hasBitso && (
        <div className="error-msg">
          ⚠ NO HAS CONECTADO TU API DE BITSO. VE A <Link to="/settings">CONFIG</Link> PARA CONECTARLA.
        </div>
      )}

      <div className="stat-grid">
        <Stat label="OPERACIONES" value={trades.length} accent="green" />
        <Stat label="COMPRAS" value={buys} accent="green" />
        <Stat label="VENTAS" value={sells} accent="magenta" />
        <Stat label="SEÑALES IA" value={signals.length} accent="yellow" />
        <Stat label="AUTO-TRADING" value={user?.autoTrade ? 'ON' : 'OFF'} accent={user?.autoTrade ? 'green' : ''} />
      </div>

      {error && <div className="error-msg">{error}</div>}

      {balances.length > 0 && (
        <Panel title="◈ SALDO EN BITSO">
          <div className="stat-grid">
            {balances
              .filter((b) => ['mxn', 'btc', 'eth', 'usdc', 'usdt', 'xrp', 'sol'].includes(String(b.currency).toLowerCase()))
              .slice(0, 6)
              .map((b) => (
                <Stat key={b.currency} label={String(b.currency).toUpperCase()} value={b.available} accent="cyan" />
              ))}
          </div>
        </Panel>
      )}

      <Panel title="◈ ÚLTIMAS SEÑALES DE IA">
        {signals.length === 0 ? (
          <div className="muted center">AÚN NO HAY SEÑALES. EL BOT GENERARÁ SEÑALES CUANDO TENGAS BITSO CONECTADO.</div>
        ) : (
          <table className="retro-table">
            <thead>
              <tr>
                <th>PAR</th>
                <th>ACCIÓN</th>
                <th>CONF.</th>
                <th>RAZÓN</th>
              </tr>
            </thead>
            <tbody>
              {signals.slice(0, 12).map((s) => (
                <tr key={s.id}>
                  <td>{s.symbol}</td>
                  <td>
                    <span className={`badge ${s.action.toLowerCase()}`}>{s.action}</span>
                  </td>
                  <td>{(Number(s.confidence) * 100).toFixed(0)}%</td>
                  <td className="muted">{s.reasoning || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="◈ HISTORIAL DE OPERACIONES">
        {trades.length === 0 ? (
          <div className="muted center">SIN OPERACIONES TODAVÍA.</div>
        ) : (
          <table className="retro-table">
            <thead>
              <tr>
                <th>PAR</th>
                <th>LADO</th>
                <th>MONTO</th>
                <th>PRECIO</th>
                <th>ESTADO</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 12).map((t) => (
                <tr key={t.id}>
                  <td>{t.symbol}</td>
                  <td>
                    <span className={`badge ${t.side.toLowerCase()}`}>{t.side}</span>
                  </td>
                  <td>{t.amount}</td>
                  <td>{t.price}</td>
                  <td>
                    <span className={`badge ${t.status.toLowerCase()}`}>{t.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
