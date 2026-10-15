const BASE = '/api';

async function raw(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {};
  if (opts.body) headers['Content-Type'] = 'application/json';
  const token = localStorage.getItem('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(BASE + path, { ...opts, headers });
}

async function tryRefresh(): Promise<boolean> {
  const refresh = localStorage.getItem('refresh');
  if (!refresh) return false;
  try {
    const res = await fetch(BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    localStorage.setItem('token', data.token);
    return true;
  } catch {
    return false;
  }
}

/** Cliente de API con refresco de token y reintentos ante cortes/red. */
export async function api(path: string, opts: RequestInit = {}): Promise<any> {
  async function attempt(): Promise<Response> {
    try {
      return await raw(path, opts);
    } catch {
      // Error de red (servidor reiniciándose): esperar y reintentar
      await new Promise((r) => setTimeout(r, 1000));
      return raw(path, opts);
    }
  }

  let res = await attempt();

  if (res.status === 401) {
    const ok = await tryRefresh();
    if (ok) res = await attempt();
  }

  // 502/503 = API reiniciándose → reintentar una vez
  if (res.status === 502 || res.status === 503) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await attempt();
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Error de red (${res.status})`);
  return data;
}
