import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PixelButton, Panel, Field } from '../components/Retro';

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await register(email, password, name || undefined, token || undefined);
      nav('/dashboard');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="logo-big">HAPPYTRADING</div>
      <div className="logo-sub">▚▚ NUEVO JUGADOR ▞▞</div>
      <Panel title="▶ CREAR CUENTA">
        <form onSubmit={submit} className="stack">
          <Field label="NOMBRE (OPCIONAL)">
            <input className="pixel-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="EMAIL">
            <input
              className="pixel-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </Field>
          <Field label="CONTRASEÑA (MÍN. 8)">
            <input
              className="pixel-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="TOKEN DE INVITACIÓN">
            <input
              className="pixel-input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="si aplica"
            />
          </Field>
          {error && <div className="error-msg">{error}</div>}
          <PixelButton type="submit" variant="primary" disabled={busy}>
            {busy ? 'CARGANDO...' : '▶ REGISTRAR'}
          </PixelButton>
        </form>
        <div className="muted center mt">
          ¿YA TIENES CUENTA? <Link to="/login">INICIA SESIÓN</Link>
        </div>
      </Panel>
    </div>
  );
}
