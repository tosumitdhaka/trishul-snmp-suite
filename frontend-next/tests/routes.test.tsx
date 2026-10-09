// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { workspaces } from '../src/lib/navigation/workspaces';
import { Placeholder } from '../src/features/shared/Placeholder';

describe('migration boundary', () => {
  it('includes exactly the seven legacy workspaces', () => {
    expect(workspaces.map((page) => page.path)).toEqual([
      '/', '/simulator', '/walker', '/traps', '/browser', '/mibs', '/settings',
    ]);
  });
  it('routes incomplete workspaces explicitly back to the legacy UI', () => {
    const workspace = workspaces.find((page) => page.path === '/traps')!;
    render(<MemoryRouter><Placeholder workspace={workspace} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Traps' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open legacy workspace/i })).toHaveAttribute('href', '/#traps');
  });
});
