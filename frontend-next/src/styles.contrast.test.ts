import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
function token(section: string, name: string): string {
  const match = section.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})'));
  if (!match) throw new Error('Missing hex color token: ' + name);
  return match[1];
}
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i,i+2), 16)/255)
    .map(c => c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4);
  return 0.2126*channels[0] + 0.7152*channels[1] + 0.0722*channels[2];
}
function contrast(a: string, b: string): number {
  const hi=Math.max(luminance(a),luminance(b));
  const lo=Math.min(luminance(a),luminance(b));
  return (hi+0.05)/(lo+0.05);
}
describe('destructive button hover token contrast', () => {
  it('passes WCAG AA normal-text ratio in light and dark palettes', () => {
    const palettes = [...css.matchAll(/:root(?:\\[data-theme="dark"\\])?\\s*\\{([^}]+)\\}/g)].map(x=>x[1]);
    expect(palettes).toHaveLength(2);
    for(const palette of palettes) expect(contrast(token(palette, 'danger'),token(palette, 'on-danger-hover'))).toBeGreaterThanOrEqual(4.5);
  });
});
