import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { sfxCoin } from '../lib/sfx';
import { Panel, Stat } from '../components/Retro';
import BotActivity from '../components/BotActivity';
import Portfolio from '../components/Portfolio';
import StatusBox from '../components/StatusBox';
import Positions from '../components/Positions';
import Instructions from '../components/Instructions';
import Usage from '../components/Usage';
import RecentTrades from '../components/RecentTrades';
import Signals from '../components/Signals';
import MarketThermometer from '../components/MarketThermometer';
import ProfitVault from '../components/ProfitVault';

export default function Dashboard() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => {
      Promise.all([api('/me/trades'), api('/me/signals')])
        .then(([t, s]) => {
          setTrades(t);
          setSignals(s);
        })
        .catch((e) => setError(e.message));
      if (true) {
        api('/me/balance')
          .then((d) => setBalances(d.balances ?? []))
          .catch(() => {});
      }    };
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);

  const buys = trades.filter((t) => t.side === 'BUY').length;
  const sells = trades.filter((t) => t.side === 'SELL').length;

  const lastTrade = useRef<string | null>(null);
  useEffect(() => {
    if (!trades.length) return;
    const top = trades[0];
    if (lastTrade.current && top.id !== lastTrade.current && top.side === 'BUY') sfxCoin();
    lastTrade.current = top.id;
  }, [trades]);

  return (
    <div>
      <div className="spread mb">
        <h2 style={{ fontFamily: 'var(--font-pixel)', fontSize: 14 }} className="floaty grad-text">
          BIENVENIDO, {user?.name || user?.username || user?.email}
        </h2>
        <span className="floaty" style={{ fontSize: 26 }}>🪙</span>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="dash">
        <div className="dash-full">
          <StatusBox />
        </div>
        <div className="dash-full">
          <Portfolio />
        </div>

        <div className="dash-full">
          <div className="stat-grid" style={{ marginBottom: 0 }}>
            <Stat label="OPERACIONES" value={trades.length} accent="green" />
            <Stat label="COMPRAS" value={buys} accent="green" />
            <Stat label="VENTAS" value={sells} accent="magenta" />
            <Stat label="SEÑALES IA" value={signals.length} accent="yellow" />
            <Stat label="AUTO" value={user?.autoTrade ? 'ON' : 'OFF'} accent={user?.autoTrade ? 'green' : ''} />
          </div>
        </div>

        {balances.length > 0 && (
          <div className="dash-full">
            <Panel title="◈ SALDO EN BINANCE">
              <div className="stat-grid" style={{ marginBottom: 0 }}>
                {balances
                  .filter((b) => ['mxn', 'btc', 'eth', 'usdc', 'usdt', 'xrp', 'sol', 'trx'].includes(String(b.currency).toLowerCase()))
                  .slice(0, 8)
                  .map((b) => (
                    <Stat key={b.currency} label={String(b.currency).toUpperCase()} value={b.available} accent="cyan" />
                  ))}
              </div>
            </Panel>
          </div>
        )}

        <MarketThermometer />
        <ProfitVault />
        
        <Positions />
        <Instructions />
        <RecentTrades trades={trades} />
        <Signals signals={signals} />
        <Usage />

        <div className="dash-full">
          <BotActivity />
        </div>
      </div>
    </div>
  );
}
