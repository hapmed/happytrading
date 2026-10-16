import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, Stat, PixelButton, Field, Toggle } from '../components/Retro';

type Tab = 'users' | 'settings';

export default function Admin() {
  const [tab, setTab] = useState<Tab>('users');
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [secure, setSecure] = useState(false);
  const [regimeFilter, setRegimeFilter] = useState(true);
  const [providers, setProviders] = useState<any[]>([]);

  const updateProv = (i: number, patch: any) =>
    setProviders((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const removeProv = (i: number) => setProviders((ps) => ps.filter((_, j) => j !== i));

  const load = () => {
    Promise.all([api('/admin/stats'), api('/admin/users'), api('/admin/settings')])
      .then(([s, u, cfg]) => {
        setStats(s);
        setUsers(u);
        setSettings(cfg);
        setSecure(!!cfg.smtp?.secure);
        setRegimeFilter(cfg.bot?.regimeFilter !== false);
        setProviders(Array.isArray(cfg.providers) ? cfg.providers : []);
      })
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
  }, []);

  const newUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = e.target as any;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: f.email.value,
          password: f.password.value,
          name: f.name.value || undefined,
        }),
      });
      f.reset();
      setMsg('USUARIO CREADO ✔');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (id: string, status: string) => {
    try {
      await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }),
      });
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const removeUser = async (id: string) => {
    if (!confirm('¿Eliminar este usuario y todos sus datos?')) return;
    try {
      await api(`/admin/users/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = e.target as any;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          smtp: {
            host: f.smtp_host.value,
            port: Number(f.smtp_port.value) || 587,
            secure,
            user: f.smtp_user.value || undefined,
            pass: f.smtp_pass.value || undefined,
            from: f.smtp_from.value || undefined,
          },
          gemini: f.gemini_key.value || f.gemini_model.value ? { apiKey: f.gemini_key.value, model: f.gemini_model.value } : null,
          openrouter: f.or_key.value || f.or_model.value ? { apiKey: f.or_key.value, model: f.or_model.value } : null,
          bot: { intervalMs: Math.max(30, Number(f.bot_interval.value) || 300) * 1000, regimeFilter },
          limits: {
            gemini: { requestsPerDay: Number(f.lim_gemini_req.value) || 1500, tokensPerDay: Number(f.lim_gemini_tok.value) || 1000000 },
            openrouter: { requestsPerDay: Number(f.lim_or_req.value) || 50, tokensPerDay: Number(f.lim_or_tok.value) || 1000000 },
          },
          providers: providers.length ? providers : null,
          registration_token: f.reg_token.value ? { value: f.reg_token.value } : null,
          turnstile: f.ts_site.value
            ? { siteKey: f.ts_site.value, secretKey: f.ts_secret.value }
            : null,
        }),
      });
      setMsg('CONFIGURACIÓN GUARDADA ✔');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const testSmtp = async () => {
    const to = prompt('Correo de destino para la prueba:');
    if (!to) return;
    setErr('');
    try {
      await api('/admin/settings/test-smtp', { method: 'POST', body: JSON.stringify({ to }) });
      setMsg('CORREO DE PRUEBA ENVIADO ✔');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <div className="spread mb">
        <h2 style={{ fontFamily: 'var(--font-pixel)', fontSize: 14, color: 'var(--yellow)' }}>
          ⚠ PANEL DE ADMINISTRACIÓN
        </h2>
        <div className="row">
          <PixelButton variant={tab === 'users' ? 'primary' : ''} onClick={() => setTab('users')}>
            USUARIOS
          </PixelButton>
          <PixelButton variant={tab === 'settings' ? 'primary' : ''} onClick={() => setTab('settings')}>
            CONFIG GLOBAL
          </PixelButton>
        </div>
      </div>

      {stats && (
        <div className="stat-grid">
          <Stat label="USUARIOS" value={stats.users} accent="green" />
          <Stat label="OPERACIONES" value={stats.trades} accent="cyan" />
          <Stat label="SEÑALES" value={stats.signals} accent="yellow" />
          <Stat label="SNAPSHOTS" value={stats.snapshots} accent="magenta" />
        </div>
      )}

      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="error-msg">{err}</div>}

      {tab === 'users' && (
        <>
          <Panel title="◈ CREAR USUARIO">
            <form onSubmit={newUser} className="stack">
              <Field label="EMAIL">
                <input className="pixel-input" name="email" type="email" required />
              </Field>
              <Field label="CONTRASEÑA TEMPORAL">
                <input className="pixel-input" name="password" type="text" required />
              </Field>
              <Field label="NOMBRE (OPCIONAL)">
                <input className="pixel-input" name="name" />
              </Field>
              <PixelButton type="submit" variant="primary" disabled={busy}>
                {busy ? 'GUARDANDO...' : '▶ CREAR'}
              </PixelButton>
            </form>
          </Panel>

          <Panel title="◈ USUARIOS REGISTRADOS">
            <table className="retro-table">
              <thead>
                <tr>
                  <th>EMAIL</th>
                  <th>ROL</th>
                  <th>BITSO</th>
                  <th>ESTADO</th>
                  <th>ACCIONES</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.email}
                      {u.username && <div className="muted">@{u.username}</div>}
                    </td>
                    <td>{u.role}</td>
                    <td>{u.hasBitso ? '✔' : '—'}</td>
                    <td>
                      <span className={`badge ${u.status === 'ACTIVE' ? 'filled' : 'sell'}`}>{u.status}</span>
                    </td>
                    <td className="row" style={{ gap: 6 }}>
                      <PixelButton className="small" onClick={() => toggleStatus(u.id, u.status)}>
                        {u.status === 'ACTIVE' ? 'BLOQ' : 'ACT'}
                      </PixelButton>
                      {u.role !== 'ADMIN' && (
                        <PixelButton className="small danger" onClick={() => removeUser(u.id)}>
                          DEL
                        </PixelButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      {tab === 'settings' && settings && (
        <Panel title="◈ CONFIGURACIÓN GLOBAL">
          <form onSubmit={saveSettings} className="stack">
            <h3 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--cyan)' }} className="mb">
              ✉ SMTP (NOTIFICACIONES)
            </h3>
            <Field label="HOST">
              <input className="pixel-input" name="smtp_host" defaultValue={settings.smtp?.host ?? ''} placeholder="smtp.gmail.com" />
            </Field>
            <Field label="PUERTO">
              <input className="pixel-input" name="smtp_port" type="number" defaultValue={settings.smtp?.port ?? 587} />
            </Field>
            <Toggle
              label={`USAR SSL/TLS (SECURE): ${secure ? 'ON' : 'OFF'}`}
              checked={secure}
              onChange={(v: boolean) => setSecure(v)}
            />
            <Field label="USUARIO">
              <input className="pixel-input" name="smtp_user" defaultValue={settings.smtp?.user ?? ''} />
            </Field>
            <Field label="CONTRASEÑA">
              <input className="pixel-input" name="smtp_pass" type="password" defaultValue={settings.smtp?.pass ?? ''} placeholder={settings.smtp?.pass ? '••••••' : ''} />
            </Field>
            <Field label="REMITENTE (FROM)">
              <input className="pixel-input" name="smtp_from" defaultValue={settings.smtp?.from ?? ''} placeholder="HappyTrading <noreply@happytrading.app>" />
            </Field>
            <div className="row mb">
              <PixelButton type="button" onClick={testSmtp}>PROBAR ENVÍO</PixelButton>
            </div>

            <h3 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--cyan)' }} className="mb">
              🤖 GEMINI API (BOT TRADER)
            </h3>
            <Field label="API KEY">
              <input className="pixel-input" name="gemini_key" type="password" defaultValue={settings.gemini?.apiKey ?? ''} placeholder={settings.gemini?.apiKey ? '••••••' : ''} />
            </Field>
            <Field label="MODELO">
              <input className="pixel-input" name="gemini_model" defaultValue={settings.gemini?.model ?? 'gemini-3.1-flash-lite'} placeholder="gemini-3.1-flash-lite" />
            </Field>

            <h3 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--cyan)' }} className="mb">
              🧠 OPENROUTER (RESPALDO · MODELOS GRATIS)
            </h3>
            <Field label="API KEY">
              <input className="pixel-input" name="or_key" type="password" defaultValue={settings.openrouter?.apiKey ?? ''} placeholder={settings.openrouter?.apiKey ? '••••••' : 'sk-or-v1-...'} />
            </Field>
            <Field label="MODELO">
              <input className="pixel-input" name="or_model" defaultValue={settings.openrouter?.model ?? 'google/gemma-4-31b-it:free'} placeholder="google/gemma-4-31b-it:free" />
            </Field>
            <p className="muted mb" style={{ fontSize: 16 }}>
              Se <b>intercala con Gemini</b> para repartir la carga (permite bajar el intervalo).
            </p>

            <h3 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--cyan)' }} className="mb">
              ⏱ RITMO DEL BOT
            </h3>
            <Field label="INTERVALO ENTRE PASADAS (SEGUNDOS)">
              <input className="pixel-input" name="bot_interval" type="number" defaultValue={Math.round((settings.bot?.intervalMs ?? 300000) / 1000)} />
            </Field>
            <p className="muted mb" style={{ fontSize: 16 }}>
              Mínimo 30. Con Gemini + OpenRouter puedes bajar a 60–120 s.
            </p>
            <Toggle
              label={`FILTRO DE RÉGIMEN: ${regimeFilter ? 'ON' : 'OFF'}`}
              checked={regimeFilter}
              onChange={(v: boolean) => setRegimeFilter(v)}
            />
            <p className="muted mb" style={{ fontSize: 16 }}>
              Con el filtro ON, el bot <b>no compra cuando el régimen es RISK-OFF</b>.
            </p>

            <h3 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--cyan)' }} className="mb">
              🚦 LÍMITES DE IA (FREE TIERS)
            </h3>
            <Field label="GEMINI · PETICIONES / DÍA">
              <input className="pixel-input" name="lim_gemini_req" type="number" defaultValue={settings.limits?.gemini?.requestsPerDay ?? 1500} />
            </Field>
            <Field label="GEMINI · TOKENS / DÍA">
              <input className="pixel-input" name="lim_gemini_tok" type="number" defaultValue={settings.limits?.gemini?.tokensPerDay ?? 1000000} />
            </Field>
            <Field label="OPENROUTER · PETICIONES / DÍA">
              <input className="pixel-input" name="lim_or_req" type="number" defaultValue={settings.limits?.openrouter?.requestsPerDay ?? 50} />
            </Field>
            <Field label="OPENROUTER · TOKENS / DÍA">
              <input className="pixel-input" name="lim_or_tok" type="number" defaultValue={settings.limits?.openrouter?.tokensPerDay ?? 1000000} />
            </Field>
            <p className="muted mb" style={{ fontSize: 16 }}>
              Al alcanzar el límite, el bot <b>deja de usar ese proveedor</b> (y sigue con el otro). No te pasas del free tier.
            </p>

            <h3 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--cyan)' }} className="mb">
              🌐 PROVEEDORES DE IA EXTRA (OpenAI-compatible)
            </h3>
            <p className="muted mb" style={{ fontSize: 16 }}>
              Agrega APIs gratis (Groq, GitHub Models, Mistral…). Se usan en rotación con Gemini/OpenRouter.
              Ej.: <b>groq</b> · <b>https://api.groq.com/openai/v1</b> · modelos <b>llama-3.3-70b-versatile</b>.
            </p>
            {providers.map((p, i) => (
              <div className="prov" key={i}>
                <input className="pixel-input" placeholder="nombre (ej. groq)" value={p.name || ''} onChange={(e) => updateProv(i, { name: e.target.value })} />
                <input className="pixel-input" placeholder="base URL (https://api.groq.com/openai/v1)" value={p.baseUrl || ''} onChange={(e) => updateProv(i, { baseUrl: e.target.value })} />
                <input className="pixel-input" placeholder="API key" value={p.apiKey || ''} onChange={(e) => updateProv(i, { apiKey: e.target.value })} />
                <input className="pixel-input" placeholder="modelos separados por coma" value={(p.models || []).join(',')} onChange={(e) => updateProv(i, { models: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                <PixelButton className="small danger" onClick={() => removeProv(i)}>QUITAR</PixelButton>
              </div>
            ))}
            <PixelButton className="small" onClick={() => setProviders([...providers, { name: '', baseUrl: '', apiKey: '', models: [] }])}>
              + AGREGAR PROVEEDOR
            </PixelButton>

            <h3 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--cyan)' }} className="mb mt">
              🛡 ANTI-BOTS
            </h3>
            <Field label="TOKEN DE REGISTRO (vacío = abierto)">
              <input className="pixel-input" name="reg_token" defaultValue={settings.registration_token?.value ?? ''} />
            </Field>
            <Field label="TURNSTILE SITE KEY (OPCIONAL)">
              <input className="pixel-input" name="ts_site" defaultValue={settings.turnstile?.siteKey ?? ''} />
            </Field>
            <Field label="TURNSTILE SECRET KEY (OPCIONAL)">
              <input className="pixel-input" name="ts_secret" type="password" defaultValue={settings.turnstile?.secretKey ?? ''} placeholder={settings.turnstile?.secretKey ? '••••••' : ''} />
            </Field>

            <PixelButton type="submit" variant="primary" disabled={busy}>
              {busy ? 'GUARDANDO...' : '▶ GUARDAR TODO'}
            </PixelButton>
          </form>
        </Panel>
      )}
    </div>
  );
}
