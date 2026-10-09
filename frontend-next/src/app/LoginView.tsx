import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, Moon, Sun } from 'lucide-react';
import trishulLogo from '../assets/trishul-icon.svg';
import { useAuth } from '../lib/auth/AuthProvider';
import { useTheme } from '../lib/theme/ThemeProvider';

export function LoginView() {
  const { login } = useAuth();
  const { theme, setTheme } = useTheme();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') || '');
    const password = String(form.get('password') || '');
    setSubmitting(true);
    setError('');
    try {
      await login(username, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--canvas)] px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-between gap-3">
          <a href="/" className="flex items-center gap-3 text-sm font-semibold">
            <img src={trishulLogo} alt="" aria-hidden="true" className="h-10 w-10 shrink-0 object-contain" width={40} height={40} />
            <span>Trishul <span className="block text-xs font-medium text-[var(--muted)]">SNMP Suite</span></span>
          </a>
          <button className="btn-secondary" type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}>
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </div>
        <section className="panel p-7 sm:p-8" aria-labelledby="login-title">
          <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <LockKeyhole size={22} aria-hidden="true" />
          </div>
          <p className="eyebrow">Next-generation operator console</p>
          <h1 id="login-title" className="mt-2 text-2xl font-semibold tracking-tight">Sign in to Trishul</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">Uses your existing Trishul account and permissions.</p>
          <form onSubmit={handleSubmit} className="mt-7 space-y-5">
            <div>
              <label className="field-label" htmlFor="login-username">Username</label>
              <input className="field-input" id="login-username" name="username" autoComplete="username" required autoFocus />
            </div>
            <div>
              <label className="field-label" htmlFor="login-password">Password</label>
              <input className="field-input" id="login-password" name="password" type="password" autoComplete="current-password" required />
            </div>
            {error && <p role="alert" className="rounded-lg bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger)]">{error}</p>}
            <button className="btn-primary w-full justify-center" type="submit" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'} <ArrowRight size={16} aria-hidden="true" />
            </button>
          </form>
          <p className="mt-6 text-xs leading-relaxed text-[var(--muted)]">
            Modern UI preview. Operational workflows remain available in the <a className="link" href="/">legacy console</a>.
          </p>
        </section>
      </div>
    </main>
  );
}
