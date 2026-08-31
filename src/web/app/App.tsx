// Application root component. Routes + auth context + layout.
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Sidebar } from '../components/sidebar';
import { TopBar } from '../components/top-bar';
import { Login } from './pages/login';
import { Setup } from './pages/setup';
import { Dashboard } from './pages/dashboard';
import { Providers } from './pages/providers';
import { Models } from './pages/models';
import { Combos } from './pages/combos';
import { Aliases } from './pages/aliases';
import { ApiKeys } from './pages/api-keys';
import { Requests } from './pages/requests';
import { Statistics } from './pages/statistics';
import { AuditLogs } from './pages/audit';
import { Settings } from './pages/settings';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { RequestNotifications } from '../components/request-notifications';
import { useRequestNotifications } from '../lib/request-events';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function Shell() {
  const { items, dismiss } = useRequestNotifications();
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/models" element={<Models />} />
            <Route path="/combos" element={<Combos />} />
            <Route path="/aliases" element={<Aliases />} />
            <Route path="/api-keys" element={<ApiKeys />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/statistics" element={<Statistics />} />
            <Route path="/audit" element={<AuditLogs />} />
            <Route path="/settings/*" element={<Settings />} />
          </Routes>
        </main>
      </div>
      <RequestNotifications items={items} onDismiss={dismiss} />
    </div>
  );
}

function SetupGate({ children }: { children: React.ReactNode }) {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const location = useLocation();
  useEffect(() => {
    api.get<{ setupComplete: boolean; masterKeyConfigured: boolean }>('/api/admin/setup/status')
      .then((r) => setSetupComplete(r.setupComplete))
      .catch(() => setSetupComplete(true));
  }, []);
  if (setupComplete === null) return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  if (!setupComplete && location.pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (setupComplete && location.pathname === '/setup') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <SetupGate>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<RequireAuth><Shell /></RequireAuth>} />
        </Routes>
      </SetupGate>
    </AuthProvider>
  );
}
