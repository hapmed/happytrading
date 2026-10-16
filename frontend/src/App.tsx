import React from 'react';
import { Navigate, Route, Routes, Link, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Admin from './pages/Admin';
import HowItWorks from './pages/HowItWorks';
import Scriptable from './pages/Scriptable';

const TICKER = 'BTC/MXN ▲ · ETH/MXN ▼ · XRP/MXN ▲ · LTC/MXN ▲ · MANA/MXN ▼ · SOL/MXN ▲ · DAI/MXN ◆';

function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();

  return (
    <div className="app-shell">
      <div className="marquee">
        <div className="marquee-inner">
          {TICKER} &nbsp;&nbsp;·&nbsp;&nbsp; {TICKER}
        </div>
      </div>
      <nav className="topnav">
        <div className="logo">
          <img src="/logo.png" alt="" className="nav-logo" />
          HAPPYTRADING<span className="cursor" />
        </div>
        <div className="nav-links">
          <Link to="/dashboard" className="pixel-btn small ghost">
            PANEL
          </Link>
          <Link to="/settings" className="pixel-btn small ghost">
            CONFIG
          </Link>
          <Link to="/how" className="pixel-btn small ghost">
            ¿CÓMO?
          </Link>
          <Link to="/scriptable" className="pixel-btn small ghost">
            WIDGET
          </Link>
          {user?.role === 'ADMIN' && (
            <Link to="/admin" className="pixel-btn small ghost">
              ADMIN
            </Link>
          )}
        </div>
        <div className="nav-user">
          <span>▸ {user?.username || user?.email}</span>
          <button className="pixel-btn small danger" onClick={() => { logout(); nav('/login'); }}>
            SALIR
          </button>
        </div>
      </nav>
      <div className="container">{children}</div>
      <div className="fx-coins" aria-hidden="true">
        {['🪙', '💸', '📈', '🪙', '💵', '📉', '🪙', '💰'].map((e, i) => (
          <span key={i} style={{ left: `${(i * 13 + 4) % 96}%`, animationDelay: `${i * 1.7}s`, fontSize: `${16 + (i % 3) * 10}px` }}>
            {e}
          </span>
        ))}
      </div>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center mt muted">CARGANDO...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center mt muted">CARGANDO...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'ADMIN') return <Navigate to="/dashboard" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to="/dashboard" replace /> : <Register />} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/how" element={<Protected><HowItWorks /></Protected>} />
      <Route path="/scriptable" element={<Protected><Scriptable /></Protected>} />
      <Route path="/admin" element={<AdminOnly><Admin /></AdminOnly>} />
      <Route path="/" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
