import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

export interface User {
  id: string;
  username?: string;
  email: string;
  name?: string;
  role: string;
  status: string;
  hasBitso: boolean;
  tradingEnabled: boolean;
  autoTrade: boolean;
  rotate: boolean;
  autoSince: string | null;
  autoTotalSec: number;
  volatileTop: number | null;
  maxOrderAmount: string | null;
  stopLossPct: string | null;
  takeProfitPct: string | null;
  initialCapital: string | null;
  riskPct: string | null;
  cashReservePct: string | null;
  profile: string;
  symbols: string | null;
  dcaLevels: number | null;
  dcaStepPct: string | null;
}

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, token?: string) => Promise<void>;
  logout: () => void;
  setUser: (u: User | null) => void;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      setLoading(false);
      return;
    }
    api('/me/profile')
      .then((u) => setUser(u))
      .catch((err) => {
        // Solo cerrar sesión si el servidor rechazó el token (401).
        // Si es un error de red transitorio (reinicio), NO expulsar al usuario.
        if ((err as any)?.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('refresh');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (identifier: string, password: string) => {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    });
    localStorage.setItem('token', data.token);
    localStorage.setItem('refresh', data.refresh);
    setUser(data.user);
  };

  const register = async (email: string, password: string, name: string, token?: string) => {
    const data = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, token }),
    });
    localStorage.setItem('token', data.token);
    localStorage.setItem('refresh', data.refresh);
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refresh');
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, loading, login, register, logout, setUser }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  return useContext(Ctx);
}
