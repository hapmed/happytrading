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

      <Panel title="◈ CONEXIÓN BINANCE">
        <div className="ok-msg">✔ BINANCE CONECTADO (llaves cifradas en la config global)</div>
        <p className="muted mb" style={{ fontSize: 16 }}>
          El bot opera en <b>Binance</b> (comisiones 0.1%). Configura tus llaves de Binance en
          <b> ADMIN → CONFIG GLOBAL → Binance</b>.
        </p>
      </Panel>

      <Panel title="◈ RETIRO DE GANANCIAS (SPEI → CLABE)">
        <p className="muted" style={{ fontSize: 16 }}>
          Las ganancias se pueden transferir a tu banco por <b>SPEI</b> (Binance México). Mínimo 50 MXN.
        </p>
        <Field label="CLABE (18 dígitos)">
          <input
            className="pixel-input"
            defaultValue={user?.payoutClabe ?? ''}
            onBlur={(e) => updatePref({ payoutClabe: e.target.value.replace(/\D/g, '') })}
            placeholder="014580140494367822"
          />
        </Field>
        <Field label="BENEFICIARIO (titular de la cuenta)">
          <input
            className="pixel-input"
            defaultValue={user?.payoutBeneficiary ?? ''}
            onBlur={(e) => updatePref({ payoutBeneficiary: e.target.value })}
            placeholder="Hector Pena"
          />
        </Field>
        <Field label="BANCO">
          <input
            className="pixel-input"
            defaultValue={user?.payoutBank ?? ''}
            onBlur={(e) => updatePref({ payoutBank: e.target.value })}
            placeholder="Santander"
          />
        </Field>
        <Toggle
          label="RETIRO AUTOMÁTICO DE GANANCIAS"
          checked={!!user?.payoutEnabled}
          onChange={(v) => updatePref({ payoutEnabled: v })}
        />
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
          <Toggle
            label={`ROTAR POSICIONES: ${user?.rotate ? 'ON' : 'OFF'}`}
            checked={user?.rotate}
            onChange={(v: boolean) => updatePref({ rotate: v })}
          />
          <p className="muted mb" style={{ fontSize: 16 }}>
            Con ROTAR ON, si ve una gran oportunidad y no hay efectivo, <b>vende lo que tengas en hold</b> para comprarla (ganancias más rápidas, más riesgo).
          </p>
          <Field
            label="MONEDAS MÁS VOLÁTILES A ANALIZAR"
            help="Cada pasada mide el movimiento y la IA analiza solo las N más volátiles. 0 = todas. Menos = menos tokens (free tier) y más oportunidades."
          >
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.volatileTop ?? 3}
              onBlur={(e) => {
                const v = parseInt(e.target.value);
                if (v >= 0 && v <= 20) updatePref({ volatileTop: v });
              }}
              placeholder="ej. 3"
            />
          </Field>
          <Field
            label="MONTO MÁXIMO POR ORDEN (MXN)"
            help="Tope de dinero por cada compra. El bot nunca gastará más que esto en una sola orden."
          >
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
          <Field
            label="STOP-LOSS %"
            help="Vende SOLO (frena la pérdida) cuando el precio cae este % respecto a tu costo. Ej.: 4% → si baja 4%, vende."
          >
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
          <Field
            label="TAKE-PROFIT %"
            help="Vende SOLO (asegura ganancia) cuando el precio sube este % respecto a tu costo. Ej.: 8% → si sube 8%, vende."
          >
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
          <Field
            label="INVERSIÓN INICIAL / CAPITAL (MXN)"
            help="Cuánto dinero metiste al empezar. Sirve para calcular tu ganancia. Los depósitos posteriores se suman solos."
          >
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
          <Field
            label="RIESGO POR OPERACIÓN (% del capital)"
            help="Qué % de tu capital arriesgas por operación. Define el tamaño de la compra (a mayor riesgo, compras más grandes). 1% prudente · 4% agresivo."
          >
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
          <Field
            label="RESERVA DE EFECTIVO (%)"
            help="Cuánto dinero (MXN) dejas SIN invertir como colchón. Ej.: 10% siempre en efectivo. 0% = invierte todo."
          >
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
                ? 'AGRESIVO: 8 pares, umbral 50% (decide comprar con poca señal), busca más ganancia y hace más operaciones (más riesgo).'
                : user?.profile === 'conservative'
                  ? 'CONSERVADOR: 2 pares, umbral 70% (solo compra con señal muy fuerte) — más seguro, opera menos.'
                  : 'EQUILIBRADO: 5 pares, umbral 60%. Punto medio entre seguridad y actividad.'}
            </small>
            <br />
            <small className="muted">El perfil define pares y cuán exigente es la IA para operar (umbral de confianza).</small>
          </div>
          <Field
            label="PARES A OPERAR (coma-separados, o escribe 'auto')"
            help="Qué monedas vigila. 'auto' = todos los pares MXN de Binance · escríbelos (btc_mxn,eth_mxn) · vacío = según el perfil."
          >
            <input
              className="pixel-input"
              defaultValue={user?.symbols ?? ''}
              onBlur={(e) => updatePref({ symbols: e.target.value.trim().toLowerCase() })}
              placeholder="auto  ó  btc_mxn,eth_mxn,xrp_mxn"
            />
          </Field>
          <p className="muted mb" style={{ fontSize: 16 }}>
            <b>auto</b> = todos los pares contra MXN de Binance · vacío = según el perfil. Cualquier cripto con par en MXN funciona.
          </p>
          <Field
            label="ESCALERA DCA · Nº DE NIVELES"
            help="En cuántos tramos parte una compra. 4 = va comprando por 4 precios que bajan (promedia la entrada). 1 = todo de golpe."
          >
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.dcaLevels ?? 3}
              onBlur={(e) => {
                const v = parseInt(e.target.value);
                if (v >= 1 && v <= 10) updatePref({ dcaLevels: v });
              }}
              placeholder="ej. 3  (compra por tramos)"
            />
          </Field>
          <Field
            label="ESCALERA DCA · SEPARACIÓN ENTRE NIVELES (%)"
            help="Distancia entre cada nivel de la escalera. Ej.: 2% → compra a X, a X−2%, a X−4%, a X−6%."
          >
            <input
              className="pixel-input"
              type="number"
              defaultValue={user?.dcaStepPct ?? 2}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v >= 0 && v <= 50) updatePref({ dcaStepPct: v });
              }}
              placeholder="ej. 2  (cada nivel −2% del precio)"
            />
          </Field>
        </div>
      </Panel>
    </div>
  );
}
