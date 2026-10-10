import { describe, it, expect } from 'vitest';
import { failureFromLog } from './runLog.js';

describe('failureFromLog', () => {
  it('returns the ERROR line with the failing step line before it, timestamps stripped', () => {
    const log = [
      '[2026-10-07T11:02:42.100Z] === viewport: desktop ===',
      '[2026-10-07T11:02:42.154Z] navigate https://www.samenom.nl/',
      '[2026-10-07T11:02:58.339Z] wait for text "Bereken maandbedrag" (button)',
      '[2026-10-07T11:03:33.000Z] ERROR: wait failed (exit=1): element did not appear',
    ].join('\n');
    expect(failureFromLog(log)).toBe(
      'wait for text "Bereken maandbedrag" (button) → ERROR: wait failed (exit=1): element did not appear',
    );
  });

  it('leaves out a preceding line that is not a step', () => {
    expect(failureFromLog('=== viewport: desktop ===\nERROR: boom')).toBe('ERROR: boom');
    expect(failureFromLog('ABORTED: user aborted at pause')).toBe('ABORTED: user aborted at pause');
  });

  it('picks the LAST error when a restart produced several', () => {
    const log = 'click @e1\nERROR: first\nrun failed — restarting (restart 1/1)\nclick @e2\nERROR: second';
    expect(failureFromLog(log)).toBe('click @e2 → ERROR: second');
  });

  it('falls back to the last line, and to null for an empty log', () => {
    expect(failureFromLog('a\nb\n')).toBe('b');
    expect(failureFromLog('')).toBeNull();
    expect(failureFromLog(null)).toBeNull();
  });
});
