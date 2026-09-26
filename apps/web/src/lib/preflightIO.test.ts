import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Preflight } from '@eab/shared';

vi.mock('./api.js', () => ({
  api: {
    createPreflight: vi.fn(),
    updatePreflight: vi.fn(),
  },
}));

import { api } from './api.js';
import {
  importPortablePreflight,
  makePreflightBundle,
  parsePortablePreflights,
  toPortablePreflight,
} from './preflightIO.js';

const row: Preflight = {
  id: 7,
  name: 'essent-login',
  description: 'Log in to Mijn Essent',
  steps_json: JSON.stringify([
    { kind: 'navigate', url: 'https://mijn.essent.nl' },
    { kind: 'wait', ms: 500 },
  ]),
  retries: 2,
  retry_wait_before_ms: 100,
  retry_wait_after_ms: 0,
  restart_on_failure: 1,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-02 00:00:00',
  deleted_at: null,
};

beforeEach(() => {
  vi.mocked(api.createPreflight).mockReset();
  vi.mocked(api.updatePreflight).mockReset();
});

describe('toPortablePreflight / makePreflightBundle', () => {
  it('drops ids and timestamps and decodes steps_json', () => {
    const p = toPortablePreflight(row);
    expect(p).toEqual({
      name: 'essent-login',
      description: 'Log in to Mijn Essent',
      retries: 2,
      retry_wait_before_ms: 100,
      retry_wait_after_ms: 0,
      restart_on_failure: 1,
      steps: [
        { kind: 'navigate', url: 'https://mijn.essent.nl' },
        { kind: 'wait', ms: 500 },
      ],
    });
    expect(p).not.toHaveProperty('id');
    expect(p).not.toHaveProperty('created_at');
    const bundle = makePreflightBundle([p]);
    expect(bundle._type).toBe('eab.preflights');
    expect(bundle.preflights).toHaveLength(1);
  });

  it('round-trips through JSON text', () => {
    const text = JSON.stringify(makePreflightBundle([toPortablePreflight(row)]));
    expect(parsePortablePreflights(text)).toEqual([toPortablePreflight(row)]);
  });
});

describe('parsePortablePreflights', () => {
  it('accepts a bundle, a bare array and a single object', () => {
    const one = { name: 'a', steps: [] };
    expect(parsePortablePreflights(JSON.stringify({ preflights: [one] }))).toHaveLength(1);
    expect(parsePortablePreflights(JSON.stringify([one, { name: 'b' }]))).toHaveLength(2);
    expect(parsePortablePreflights(JSON.stringify(one))).toHaveLength(1);
  });

  it('fills defaults for missing optional fields', () => {
    const [p] = parsePortablePreflights(JSON.stringify({ name: '  trimmed  ' }));
    expect(p).toEqual({
      name: 'trimmed',
      description: '',
      retries: 0,
      retry_wait_before_ms: 0,
      retry_wait_after_ms: 0,
      restart_on_failure: 0,
      steps: [],
    });
  });

  it('rejects invalid JSON, a missing name, and a bad step', () => {
    expect(() => parsePortablePreflights('{nope')).toThrow(/Not valid JSON/);
    expect(() => parsePortablePreflights('{"steps":[]}')).toThrow(/preflight\[0\]\.name/);
    expect(() =>
      parsePortablePreflights(JSON.stringify({ name: 'x', steps: [{ kind: 'wait', ms: -1 }] })),
    ).toThrow(/preflight\[0\]\.steps\[0\]/);
    expect(() =>
      parsePortablePreflights(JSON.stringify({ name: 'x', steps: [{ kind: 'teleport' }] })),
    ).toThrow(/steps\[0\]/);
  });

  it('points a scenarios bundle to the other page', () => {
    expect(() => parsePortablePreflights(JSON.stringify({ scenarios: [] }))).toThrow(
      /scenarios bundle/,
    );
  });
});

describe('importPortablePreflight', () => {
  const portable = toPortablePreflight(row);

  it('creates when the name is free', async () => {
    vi.mocked(api.createPreflight).mockResolvedValue({ ...row, id: 42 });
    const r = await importPortablePreflight(portable, [], { overwrite: false });
    expect(r).toEqual({ name: 'essent-login', action: 'created', preflightId: 42, steps: 2 });
    expect(api.createPreflight).toHaveBeenCalledWith({
      name: 'essent-login',
      description: 'Log in to Mijn Essent',
      steps: portable.steps,
      retries: 2,
      retry_wait_before_ms: 100,
      retry_wait_after_ms: 0,
      restart_on_failure: 1,
    });
    expect(api.updatePreflight).not.toHaveBeenCalled();
  });

  it('skips an existing name unless overwrite is set', async () => {
    const r = await importPortablePreflight(portable, [row], { overwrite: false });
    expect(r).toEqual({ name: 'essent-login', action: 'skipped', preflightId: 7, steps: 0 });
    expect(api.createPreflight).not.toHaveBeenCalled();
    expect(api.updatePreflight).not.toHaveBeenCalled();
  });

  it('updates the existing row in place with overwrite', async () => {
    vi.mocked(api.updatePreflight).mockResolvedValue(row);
    const r = await importPortablePreflight(portable, [row], { overwrite: true });
    expect(r).toEqual({ name: 'essent-login', action: 'updated', preflightId: 7, steps: 2 });
    expect(api.updatePreflight).toHaveBeenCalledWith(7, {
      description: 'Log in to Mijn Essent',
      steps: portable.steps,
      retries: 2,
      retry_wait_before_ms: 100,
      retry_wait_after_ms: 0,
      restart_on_failure: 1,
    });
    expect(api.createPreflight).not.toHaveBeenCalled();
  });
});
