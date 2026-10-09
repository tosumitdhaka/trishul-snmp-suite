import { ArrowUpRight, Construction } from 'lucide-react';
import { Link } from 'react-router';
import type { Workspace } from '../../lib/navigation/workspaces';

export function Placeholder({ workspace }: { workspace: Workspace }) {
  return (
    <section className="mx-auto max-w-3xl py-12" aria-labelledby="placeholder-title">
      <div className="panel p-8">
        <div className="mb-5 inline-flex rounded-xl bg-[var(--accent-soft)] p-3 text-[var(--accent)]">
          <Construction size={24} aria-hidden="true" />
        </div>
        <p className="eyebrow">Modern UI / Migration pending</p>
        <h2 id="placeholder-title" className="mt-2 text-2xl font-semibold">{workspace.label}</h2>
        <p className="mt-3 max-w-xl leading-relaxed text-[var(--muted)]">
          {workspace.description}. This workspace has not been migrated yet.
          Continue using the fully functional legacy interface until feature parity is validated.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <a className="btn-primary" href={'/#' + (workspace.path === '/' ? 'dashboard' : workspace.path.slice(1))}>
            Open legacy workspace <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <Link className="btn-secondary" to="/">Back to overview</Link>
        </div>
      </div>
    </section>
  );
}
