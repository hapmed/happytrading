import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PixelButton, Panel, Field } from '../components/Retro';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(identifier, password);
      nav('/dashboard');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <img src="/logo.png" alt="HappyTrading" className="auth-logo floaty" />
      <div className="logo-big">HAPPYTRADING</div>
      <div className="logo-sub">▚▚ CRYPTO BOT 8-BIT ▞▞</div>
      <Panel title="▶ INICIAR SESIÓN">
        <form onSubmit={submit} className="stack">
          <Field label="USUARIO O EMAIL">
            <input
              className="pixel-input"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </Field>
          <Field label="CONTRASEÑA">
            <input
              className="pixel-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error && <div className="error-msg">{error}</div>}
          <PixelButton type="submit" variant="primary" disabled={busy}>
            {busy ? 'CARGANDO...' : '▶ ENTRAR'}
          </PixelButton>
        </form>
        <div className="muted center mt">
          ¿SIN CUENTA? <Link to="/register">REGÍSTRATE</Link>
        </div>
      </Panel>
      <div className="muted center mt" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8 }}>
        AUTOMATIZA TUS GANANCIAS EN BINANCE
      </div>
    </div>
  );
}
