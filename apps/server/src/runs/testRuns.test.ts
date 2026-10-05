import { describe, it, expect, beforeEach } from 'vitest';
import { isTestRunId, testRuns } from './testRuns.js';

describe('Test runs', () => {
  beforeEach(() => testRuns.clear());

  it('hands out negative ids that can never be a Run row', () => {
    const a = testRuns.create(7).runId;
    const b = testRuns.create(7).runId;
    expect(a).toBe(-1);
    expect(b).toBe(-2);
    expect(isTestRunId(a)).toBe(true);
    expect(isTestRunId(1)).toBe(false);
    expect(isTestRunId(0)).toBe(false);
  });

  it('looks like a Run row while running and after finishing', () => {
    const { runId } = testRuns.create(7);
    const row = testRuns.get(runId)!;
    expect(row).toMatchObject({ id: runId, scenario_id: 7, status: 'running', finished_at: null, log_text: '' });
    expect(row.screenshot_paths_json).toBe('[]');

    testRuns.appendLog(runId, 'line 1');
    expect(testRuns.get(runId)?.log_text).toBe('line 1');

    testRuns.finish(runId, 'failed', 'line 1\nline 2');
    expect(testRuns.get(runId)).toMatchObject({ status: 'failed', log_text: 'line 1\nline 2' });
    expect(testRuns.get(runId)?.finished_at).not.toBeNull();
  });

  it('forgets the oldest runs beyond the keep limit', () => {
    const first = testRuns.create(1).runId;
    for (let i = 0; i < 20; i++) testRuns.create(1);
    expect(testRuns.get(first)).toBeUndefined();
    expect(testRuns.get(-2)).toBeDefined();
  });
});
