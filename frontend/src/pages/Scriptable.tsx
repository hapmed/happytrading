import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, PixelButton } from '../components/Retro';
import { buildWidgetScript } from '../lib/widgetScript';

export default function Scriptable() {
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/me/widget-token')
      .then((d) => setToken(d.token))
      .catch(() => {});
  }, []);

  const base = typeof window !== 'undefined' ? window.location.origin : '';
  const code = token ? buildWidgetScript(base, token) : 'Cargando…';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const rotate = async () => {
    if (!confirm('¿Generar un token nuevo? El widget anterior dejará de funcionar.')) return;
    setBusy(true);
    try {
      const d = await api('/me/widget-token/rotate', { method: 'POST' });
      setToken(d.token);
    } catch {}
    setBusy(false);
  };

  return (
    <div>
      <div className="spread mb">
        <h2 style={{ fontFamily: 'var(--font-pixel)', fontSize: 14, color: 'var(--green)' }}>
          📱 WIDGET DE iOS (SCRIPTABLE)
        </h2>
        <span className="floaty" style={{ fontSize: 26 }}>🐺</span>
      </div>

      <Panel title="◈ ¿QUÉ ES?">
        <div className="how-step">Un <b>widget</b> en tu iPhone/iPad que muestra tu <b>bóveda</b> (lo que ya llevas ganado) en vivo, con Clawd y una frase. 🔥</div>
        <div className="how-step">Se hace con la app <b>Scriptable</b> (gratis). Copia el código de abajo y listo.</div>
        <div className="how-step muted">Se actualiza solo (iOS lo refresca periódicamente) usando un token único tuyo.</div>
      </Panel>

      <Panel title="◈ PASOS">
        <div className="how-step"><b>1.</b> Instala <b>Scriptable</b> (App Store, gratis).</div>
        <div className="how-step"><b>2.</b> Ábrela → botón <b>+</b> → pega <b>todo el código</b> de abajo.</div>
        <div className="how-step"><b>3.</b> Ponle nombre al script: <b>HappyTrading</b>.</div>
        <div className="how-step"><b>4.</b> En la pantalla de inicio: mantén pulsado → <b>+</b> → busca <b>Scriptable</b>.</div>
        <div className="how-step"><b>5.</b> Añade el widget (<b>Mediano</b>) → mantenlo pulsado → <b>Editar widget</b> → Script: <b>HappyTrading</b>.</div>
      </Panel>

      <Panel title="◈ CÓDIGO (cópialo y pégalo en Scriptable)">
        <div className="row mb">
          <PixelButton variant="primary" onClick={copy}>{copied ? '✔ COPIADO' : '📋 COPIAR CÓDIGO'}</PixelButton>
          <PixelButton onClick={rotate} disabled={busy}>{busy ? '...' : '🔑 TOKEN NUEVO'}</PixelButton>
        </div>
        <textarea className="pixel-input code-box" readOnly value={code} onFocus={(e) => e.currentTarget.select()} />
        <p className="muted center" style={{ fontSize: 15, marginTop: 8 }}>
          Tu token: <b>{token ? `${token.slice(0, 6)}…${token.slice(-4)}` : '—'}</b> · mantén pulsado el código o usa 📋 COPIAR.
        </p>
      </Panel>
    </div>
  );
}
