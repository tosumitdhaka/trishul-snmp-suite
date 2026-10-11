import { describe, expect, it } from 'vitest';
import { toastDurationMs, TOAST_DURATION_MS } from './ToastViewport';
it('keeps error and partial messages longer than success',()=>{
  expect(toastDurationMs('success')).toBe(TOAST_DURATION_MS);
  expect(toastDurationMs('warning')).toBeGreaterThan(TOAST_DURATION_MS);
  expect(toastDurationMs('error')).toBeGreaterThan(toastDurationMs('warning'));
});
