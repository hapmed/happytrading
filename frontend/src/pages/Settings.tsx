import React, { useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Panel, Field, PixelButton, Toggle } from '../components/Retro';

export default function Settings() {
  const { user, setUser } = useAuth();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const saveBitso = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api('/me/bitso', {
        method: 'PUT',
        body: JSON.stringify({ apiKey, apiSecret }),
      });
      setApiKey('');
      setApiSecret('');
      setMsg('API DE BITSO CONECTADA ✔');
      setUser({ ...user!, hasBitso: true });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeBitso = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('/me/bitso', { method: 'DELETE' });
      setMsg('API DE BITSO ELIMINADA');
      setUser({ ...user!, hasBitso: false });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updatePref = async (patch: any) => {
    setErr('');
    try {
      const u = await api('/me/trading', { method: 'PUT', body: JSON.stringify(patch) });
      setUser(u);
      setMsg('PREFERENCIAS GUARDADAS ✔');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-pixel)', fontSize: 14, color: 'var(--green)' }} className="mb">
        ⚙ CONFIGURACIÓN
      </h2>

      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="error-msg">{err}</div>}

      <Panel title="◈ CONEXIÓN BITSO">
        {user?.hasBitso ? (
          <div>
            <div className="ok-msg">✔ API DE BITSO CONECTADA (CLAVES CIFRADAS)</div>
            <PixelButton variant="danger" onClick={removeBitso} disabled={busy}>
              DESCONECTAR
            </PixelButton>
          </div>
        ) : (
          <form onSubmit={saveBitso} className="stack">
            <p className="muted mb">
              Genera tus claves en <strong>bitso.com → Configuración → API Keys</strong>. Solo se requieren permisos de
              <em> lectura y trading</em>. Se cifran con AES-256 antes de guardarse.
            </p>
            <Field label="API KEY">
              <input className="pixel-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
            <Field label="API SECRET">
              <input className="pixel-input" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
            </Field>
            <PixelButton type="submit" variant="primary" disabled={busy}>
              {busy ? 'GUARDANDO...' : '▶ CONECTAR'}
            </PixelButton>
          </form>
        )}
      </Panel>

      <Panel title="◈ PREFERENCIAS DE TRADING">
        <div className="stack">
          <Toggle
            label={`TRADING AUTOMÁTICO: ${user?.autoTrade ? 'ON' : 'OFF'}`}
            checked={user?.autoTrade}
            onChange={(v: boolean) => updatePref({ autoTrade: v })}
          />
          <Toggle
            label={`BOT ACTIVO: ${user?.tradingEnabled ? 'ON' : 'OFF'}`}
            checked={user?.tradingEnabled}
            onChange={(v: boolean) => updatePref({ tradingEnabled: v })}
          />
          <Field label="MONTO MÁXIMO POR ORDEN (MXN)">
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.maxOrderAmount ?? ''}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v > 0) updatePref({ maxOrderAmount: v });
              }}
              placeholder="ej. 5000"
            />
          </Field>
          <Field label="STOP-LOSS %">
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.stopLossPct ?? ''}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v >= 0) updatePref({ stopLossPct: v });
              }}
              placeholder="ej. 3"
            />
          </Field>
          <Field label="TAKE-PROFIT %">
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.takeProfitPct ?? ''}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v >= 0) updatePref({ takeProfitPct: v });
              }}
              placeholder="ej. 5"
            />
          </Field>
          <Field label="INVERSIÓN INICIAL / CAPITAL (MXN)">
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.initialCapital ?? ''}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v >= 0) updatePref({ initialCapital: v });
              }}
              placeholder="ej. 10000  (para calcular tu ganancia)"
            />
          </Field>
          <Field label="RIESGO POR OPERACIÓN (% del capital)">
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.riskPct ?? 1}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v >= 0) updatePref({ riskPct: v });
              }}
              placeholder="ej. 1  (position-sizer)"
            />
          </Field>
          <Field label="RESERVA DE EFECTIVO (%)">
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.cashReservePct ?? 30}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v >= 0 && v <= 100) updatePref({ cashReservePct: v });
              }}
              placeholder="ej. 30  (no gastar todo el MXN)"
            />
          </Field>
          <div className="field">
            <span className="field-label">PERFIL DE ESTRATEGIA</span>            <div className="row" style={{ marginBottom: 8 }}>
              <PixelButton variant={user?.profile === 'conservative' ? 'primary' : ''} onClick={() => updatePref({ profile: 'conservative' })}>
                CONSERVADOR
              </PixelButton>
              <PixelButton variant={user?.profile === 'balanced' ? 'primary' : ''} onClick={() => updatePref({ profile: 'balanced' })}>
                EQUILIBRADO
              </PixelButton>
              <PixelButton variant={user?.profile === 'aggressive' ? 'primary' : ''} onClick={() => updatePref({ profile: 'aggressive' })}>
                AGRESIVO 🔥
              </PixelButton>
            </div>
            <small className="muted">
              {user?.profile === 'aggressive'
                ? 'AGRESIVO: 8 pares, umbral 50%, busca más ganancia (más riesgo).'
                : user?.profile === 'conservative'
                  ? 'CONSERVADOR: 2 pares, umbral 70% (más seguro).'
                  : 'EQUILIBRADO: 5 pares, umbral 60%.'}
            </small>
          </div>
        </div>
      </Panel>
    </div>
  );
}
