import { describe, it, expect } from 'vitest';
import { encodeSlot, parseSlot, sanitizeSlotLabel, slotDisplayLabel, slotKey, slotStamp, slotViewport } from '@eab/shared';

describe('slot filename codec', () => {
  it('encodes stamp, sanitized label, viewport and extension', () => {
    expect(encodeSlot({ stamp: '20260606-143025', label: 'check out!', viewport: 'mobile', ext: 'png' }))
      .toBe('20260606-143025-check_out_-mobile.png');
    expect(sanitizeSlotLabel('a b/c')).toBe('a_b_c');
    expect(slotStamp(new Date(2026, 5, 6, 14, 30, 25))).toBe('20260606-143025');
  });

  it('parses current names, keeping dashes inside the label', () => {
    expect(parseSlot('20260606-143025-checkout-mobile.png')).toEqual({
      position: null, stamp: '20260606-143025', label: 'checkout', viewport: 'mobile', ext: 'png',
    });
    expect(parseSlot('20260606-143025-my-long-label-desktop.webp')?.label).toBe('my-long-label');
    // A label that starts with digits is not mistaken for a position.
    expect(parseSlot('20260606-143025-404-page-desktop.png')).toMatchObject({ position: null, label: '404-page' });
    expect(parseSlot('20260606-143025-solo.JPG')?.ext).toBe('jpg');
    expect(parseSlot('notes.txt')).toBeNull();
    expect(parseSlot('nope-desktop.png')).toBeNull();
  });

  it('still parses older position-prefixed names', () => {
    expect(parseSlot('003-20260606-143025-checkout-mobile.png')).toEqual({
      position: 3, stamp: '20260606-143025', label: 'checkout', viewport: 'mobile', ext: 'png',
    });
    expect(parseSlot('012-my-long-label-desktop.webp')).toEqual({
      position: 12, stamp: null, label: 'my-long-label', viewport: 'desktop', ext: 'webp',
    });
  });

  it('keys across runs on label + viewport only, old and new alike', () => {
    expect(slotKey('20260606-143025-checkout-mobile.png')).toBe('checkout-mobile');
    expect(slotKey('003-20260606-143025-checkout-mobile.png')).toBe('checkout-mobile');
    expect(slotKey('007-20260607-090000-checkout-mobile.webp')).toBe('checkout-mobile');
    expect(slotKey('003-checkout-mobile.png')).toBe('checkout-mobile');
    // Outside the protocol: the name minus extension, never dropped.
    expect(slotKey('custom.png')).toBe('custom');
  });

  it('sorts chronologically by name within a run', () => {
    const names = ['20260606-143030-b-desktop.png', '20260606-143025-z-desktop.png', '20260606-143027-a-mobile.png'];
    expect([...names].sort()).toEqual(['20260606-143025-z-desktop.png', '20260606-143027-a-mobile.png', '20260606-143030-b-desktop.png']);
  });

  it('extracts the viewport and a display label', () => {
    expect(slotViewport('20260606-143025-checkout-mobile.png')).toBe('mobile');
    expect(slotViewport('plain.png')).toBeNull();
    expect(slotDisplayLabel('20260606-143025-checkout-mobile.png')).toBe('checkout (mobile)');
    expect(slotDisplayLabel('003-20260606-143025-checkout-mobile.png')).toBe('checkout (mobile)');
    expect(slotDisplayLabel('custom.png')).toBe('custom');
  });
});
