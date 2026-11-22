import React, { useState } from 'react';
import { ArrowRight, Moon, Sun } from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';
import { SecretInput, TrishulMark } from './UiPrimitives';

export const AuthGate: React.FC = () => {
  const { meta, theme, toggleTheme, login } = useWorkbench();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full grid lg:grid-cols-12 bg-[var(--tui-bg-canvas)] text-[var(--tui-ink-primary)]">
      {/* Left Architectural Brand Column */}
      <aside className="hidden lg:flex lg:col-span-5 flex-col justify-between p-12 bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] border-r border-[var(--tui-border-default)]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--tui-brand-soft)] border border-[var(--tui-brand-border)] flex items-center justify-center">
            <TrishulMark className="w-6 h-6" />
          </div>
          <div>
            <div className="text-base font-bold tracking-tight leading-none text-[var(--tui-ink-primary)]">
              Trishul
            </div>
            <div className="text-[11px] font-mono text-[var(--tui-brand-ink)] mt-1">
              SNMP Suite · Workbench
            </div>
          </div>
        </div>

        <div className="max-w-sm">
          <h1 className="text-3xl font-bold tracking-tight leading-tight text-balance text-[var(--tui-ink-primary)]">
            Precision SNMP operations, stripped of clutter.
          </h1>
          <p className="mt-4 text-sm text-[var(--tui-ink-secondary)] leading-relaxed">
            Simulate MIB-backed agents, walk and parse OID subtrees, inspect live trap streams, decode
            BER frames, and manage compiled bundles from one keyboard-driven workbench.
          </p>

          <dl className="mt-8 pt-6 border-t border-[var(--tui-border-default)] grid grid-cols-2 gap-6 text-xs">
            <div>
              <dt className="text-[var(--tui-ink-muted)]">Command Palette</dt>
              <dd className="mt-1 font-mono text-[var(--tui-ink-primary)]">⌘K / Ctrl+K</dd>
            </div>
            <div>
              <dt className="text-[var(--tui-ink-muted)]">Release</dt>
              <dd className="mt-1 font-mono text-[var(--tui-ink-primary)]">v{meta?.version || '2.3.0'}</dd>
            </div>
          </dl>
        </div>

        <div className="flex items-center justify-between text-xs text-[var(--tui-ink-muted)]">
          <span>FastAPI + SQLite runtime · Live WebSocket telemetry</span>
        </div>
      </aside>

      {/* Right Sign-In Column */}
      <main className="lg:col-span-7 flex flex-col justify-between p-6 sm:p-12">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 lg:hidden">
            <div className="w-8 h-8 rounded-md bg-[var(--tui-brand-soft)] border border-[var(--tui-brand-border)] flex items-center justify-center">
              <TrishulMark className="w-5 h-5" />
            </div>
            <span className="text-sm font-bold tracking-tight">Trishul Workbench</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/"
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--tui-border-control)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]"
            >
              Classic UI
            </a>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] transition-colors cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>

        <div className="w-full max-w-sm mx-auto my-auto py-8">
          <h2 className="text-xl font-bold tracking-tight text-[var(--tui-ink-primary)]">Sign in</h2>
          <p className="text-xs text-[var(--tui-ink-muted)] mt-1">
            Authenticate with your Trishul console credentials to access live SNMP services.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="next-login-user"
                className="block text-xs font-semibold text-[var(--tui-ink-secondary)] mb-1.5"
              >
                Username
              </label>
              <input
                id="next-login-user"
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full h-10 px-3 rounded-md text-sm bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
              />
            </div>

            <div>
              <label
                htmlFor="next-login-pass"
                className="block text-xs font-semibold text-[var(--tui-ink-secondary)] mb-1.5"
              >
                Password
              </label>
              <SecretInput
                id="next-login-pass"
                value={password}
                onChange={setPassword}
                placeholder="Enter password"
                autoComplete="current-password"
                required
                toggleLabel="password"
                className="!h-10 !text-sm !font-sans"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="px-3 py-2 rounded-md text-xs bg-[var(--tui-danger-soft)] border border-[var(--tui-danger-border)] text-[var(--tui-danger-ink)]"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="tui-btn-primary w-full h-10 inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:opacity-50 transition-all cursor-pointer"
            >
              <span>{submitting ? 'Signing in...' : 'Sign In'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>

        <div className="text-center text-xs text-[var(--tui-ink-muted)]">
          Trishul SNMP Suite · {meta?.description || 'Bundle-first SNMP lab and operations shell'}
        </div>
      </main>
    </div>
  );
};
