import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--canvas)] p-6">
        <section className="panel max-w-lg p-8">
          <h1 className="text-xl font-semibold">The preview encountered an error</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            The existing Trishul interface is unaffected. Reload the preview or switch back to the legacy UI.
          </p>
          <div className="mt-6 flex gap-3">
            <button className="btn-primary" onClick={() => window.location.reload()}>Reload preview</button>
            <a className="btn-secondary" href="/">Legacy UI</a>
          </div>
        </section>
      </main>
    );
  }
}
