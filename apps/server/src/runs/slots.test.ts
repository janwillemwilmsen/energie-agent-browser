import { describe, it, expect } from 'vitest';
import { encodeSlot, parseSlot, sanitizeSlotLabel, slotDisplayLabel, slotKey, slotViewport } from '@eab/shared';

describe('slot filename codec', () => {
  it('encodes position, stamp, sanitized label, viewport and extension', () => {
    expect(encodeSlot({ position: 3, stamp: '20260606-143025', label: 'check out!', viewport: 'mobile', ext: 'png' }))
      .toBe('003-20260606-143025-check_out_-mobile.png');
    expect(sanitizeSlotLabel('a b/c')).toBe('a_b_c');
  });

  it('parses stamped and un-stamped names, keeping dashes inside the label', () => {
    expect(parseSlot('003-20260606-143025-checkout-mobile.png')).toEqual({
      position: 3, stamp: '20260606-143025', label: 'checkout', viewport: 'mobile', ext: 'png',
    });
    expect(parseSlot('012-my-long-label-desktop.webp')).toEqual({
      position: 12, stamp: null, label: 'my-long-label', viewport: 'desktop', ext: 'webp',
    });
    expect(parseSlot('001-20260606-143025-solo.JPG')?.ext).toBe('jpg');
    expect(parseSlot('notes.txt')).toBeNull();
    expect(parseSlot('nope-desktop.png')).toBeNull();
  });

  it('keys across runs on label + viewport only', () => {
    expect(slotKey('003-20260606-143025-checkout-mobile.png')).toBe('checkout-mobile');
    expect(slotKey('007-20260607-090000-checkout-mobile.webp')).toBe('checkout-mobile');
    expect(slotKey('003-checkout-mobile.png')).toBe('checkout-mobile');
    // Outside the protocol: the name minus extension, never dropped.
    expect(slotKey('custom.png')).toBe('custom');
  });

  it('extracts the viewport and a display label', () => {
    expect(slotViewport('003-20260606-143025-checkout-mobile.png')).toBe('mobile');
    expect(slotViewport('plain.png')).toBeNull();
    expect(slotDisplayLabel('003-20260606-143025-checkout-mobile.png')).toBe('checkout (mobile)');
    expect(slotDisplayLabel('custom.png')).toBe('custom');
  });
});
