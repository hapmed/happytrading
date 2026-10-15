import React, { useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

export default function AutoStatus() {
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const on = !!user?.autoTrade;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const u = await api('/me/trading', { method: 'PUT', body: JSON.stringify({ autoTrade: !on }) });
      setUser(u);
    } catch {}
    setBusy(false);
  };

  return (
    <button type="button" className={`auto-banner ${on ? 'on' : 'off'}`} onClick={toggle} disabled={busy}>
      <span className="auto-dot" />
      <div className="auto-text">
        <div className="auto-title">{on ? 'AUTO ACTIVADO' : 'AUTO DETENIDO'}</div>
        <div className="auto-sub">
          {on ? 'El bot opera automáticamente en Bitso' : 'El bot solo analiza, NO operará'}
        </div>
      </div>
      <div className="auto-switch">{on ? 'ON' : 'OFF'}</div>
      <div className="auto-hint">{busy ? '...' : on ? 'TOCA PARA DETENER' : 'TOCA PARA ACTIVAR'}</div>
    </button>
  );
}
