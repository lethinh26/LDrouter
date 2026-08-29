// Admin auth context.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface AdminUser { id: string; username: string; totpEnabled: boolean }
interface AuthState { user: AdminUser | null; loading: boolean; login: (username: string, password: string, totp?: string, recoveryCode?: string) => Promise<{ totpRequired?: boolean; totpRecovery?: boolean }>; logout: () => Promise<void>; refresh: () => Promise<void> }

const AuthCtx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ id: string; username: string; totpEnabled: boolean }>('/api/admin/me');
      setUser(r);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (username: string, password: string, totp?: string, recoveryCode?: string) => {
    const body: Record<string, string> = { username, password };
    if (totp) body.totp = totp;
    if (recoveryCode) body.recoveryCode = recoveryCode;
    try {
      const r = await api.post<{ ok: boolean; username: string; totpEnabled: boolean }>('/api/admin/login', body);
      setUser({ id: 'admin', username: r.username, totpEnabled: r.totpEnabled });
      return { totpRequired: false };
    } catch (e) {
      const status = (e as { status?: number }).status;
      const type = (e as { type?: string }).type;
      if (status === 401 && type === 'totp_required') return { totpRequired: true };
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/admin/logout');
    setUser(null);
  }, []);

  return <AuthCtx.Provider value={{ user, loading, login, logout, refresh }}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
