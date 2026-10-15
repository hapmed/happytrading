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

/** Cliente de API con refresco automático de token. */
export async function api(path: string, opts: RequestInit = {}): Promise<any> {
  let res = await raw(path, opts);
  if (res.status === 401) {
    const ok = await tryRefresh();
    if (ok) res = await raw(path, opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Error de red');
  return data;
}
