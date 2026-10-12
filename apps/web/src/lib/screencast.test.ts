import { describe, it, expect } from 'vitest';
import { isBetweenPages } from './screencast.js';

describe('preview: between-pages errors', () => {
  it('recognises the frame-grab errors that mean "no page right now"', () => {
    expect(isBetweenPages('✗ CDP error (Page.captureScreenshot): Not attached to an active page')).toBe(true);
    expect(isBetweenPages('Target closed')).toBe(true);
    expect(isBetweenPages('✗ Browser has been closed')).toBe(true);
  });

  it('leaves real failures as errors', () => {
    expect(isBetweenPages('✗ Could not start session "default": spawn ENOENT')).toBe(false);
    expect(isBetweenPages('Invalid response: EOF while parsing a value')).toBe(false);
  });
});
