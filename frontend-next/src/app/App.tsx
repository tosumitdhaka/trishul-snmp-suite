import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ThemeProvider } from '../lib/theme/ThemeProvider';
import { AuthProvider, useAuth } from '../lib/auth/AuthProvider';
import { RealtimeProvider } from '../lib/realtime/RealtimeProvider';
import { WorkspaceShell } from '../components/shell/WorkspaceShell';
import { ConnectivityOverview } from '../features/dashboard/ConnectivityOverview';
import { Placeholder } from '../features/shared/Placeholder';
import { workspaces } from '../lib/navigation/workspaces';
import { LoginView } from './LoginView';
import { ErrorBoundary } from './ErrorBoundary';

function AuthenticatedApp() {
  const { auth } = useAuth();
  if (auth.state === 'checking') {
    return <main className="flex min-h-screen items-center justify-center bg-[var(--canvas)]" role="status">
      Verifying session…
    </main>;
  }
  if (auth.state === 'anonymous') return <LoginView />;
  return (
    <RealtimeProvider>
      <WorkspaceShell>
        <Routes>
          <Route path="/" element={<ConnectivityOverview />} />
          {workspaces.filter((page) => page.path !== '/').map((page) => (
            <Route key={page.path} path={page.path} element={<Placeholder workspace={page} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </WorkspaceShell>
    </RealtimeProvider>
  );
}
export function App() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false },
    },
  }));
  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AuthProvider>
            <BrowserRouter basename="/next"><AuthenticatedApp /></BrowserRouter>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
