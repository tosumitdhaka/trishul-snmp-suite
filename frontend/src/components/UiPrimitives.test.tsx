import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SecretInput, SlideDrawer, TrishulMark } from './UiPrimitives';

describe('UiPrimitives accessibility & trishul-ui alignment', () => {
  it('renders TrishulMark with unique per-instance gradient IDs and authoritative amber stops', () => {
    const { container } = render(
      <div>
        <TrishulMark />
        <TrishulMark />
      </div>
    );
    const grads = container.querySelectorAll('linearGradient');
    expect(grads).toHaveLength(2);
    expect(grads[0].id).not.toBe('');
    expect(grads[0].id).not.toBe(grads[1].id);
    const stops = grads[0].querySelectorAll('stop');
    expect(stops[0].getAttribute('stop-color')).toBe('#f59e0b');
    expect(stops[1].getAttribute('stop-color')).toBe('#d97706');
  });

  it('toggles SecretInput visibility cleanly with aria-pressed semantics', () => {
    const onChange = vi.fn();
    render(
      <SecretInput
        id="test-secret"
        value="s3cr3t"
        onChange={onChange}
        toggleLabel="SNMP community"
      />
    );
    const input = document.getElementById('test-secret') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Show SNMP community' });
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide SNMP community' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('renders SlideDrawer through Radix Dialog with accessible title and Escape dismissal', () => {
    const onClose = vi.fn();
    render(
      <SlideDrawer open={true} onClose={onClose} title="Inspect MIB Node" subtitle="IF-MIB::ifDescr">
        <p>Drawer body</p>
      </SlideDrawer>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(screen.getByText('Inspect MIB Node')).toBeTruthy();
    expect(screen.getByText('IF-MIB::ifDescr')).toBeTruthy();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
