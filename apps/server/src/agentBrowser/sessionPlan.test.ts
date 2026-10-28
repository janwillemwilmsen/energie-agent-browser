import { describe, it, expect } from 'vitest';
import { planOpen } from './sessionPlan.js';

const dead = { alive: false, boundName: null };
const unnamed = { alive: true, boundName: null };
const boundToA = { alive: true, boundName: 'a' };
const onKernel = { alive: true, boundName: null, boundBackend: 'kernel' as const };
const boundToAOnKernel = { alive: true, boundName: 'a', boundBackend: 'kernel' as const };

describe('session open plan', () => {
  it('reuse: takes whatever is up, bootstraps unnamed otherwise', () => {
    expect(planOpen({ intent: 'reuse' }, boundToA)).toEqual({ close: false, wipeName: null, connect: false, sessionName: 'a', loadState: false, backend: null });
    expect(planOpen({ intent: 'reuse' }, dead)).toEqual({ close: false, wipeName: null, connect: true, sessionName: null, loadState: false, backend: null });
  });

  it('fresh: always a new unnamed daemon', () => {
    expect(planOpen({ intent: 'fresh' }, boundToA)).toMatchObject({ close: true, connect: true, sessionName: null, loadState: false });
    expect(planOpen({ intent: 'fresh' }, dead)).toMatchObject({ close: false, connect: true, sessionName: null });
  });

  it('bind: reuses a matching daemon (re-applying state), restarts a mismatched one', () => {
    expect(planOpen({ intent: 'bind', sessionName: 'a' }, boundToA)).toEqual({ close: false, wipeName: null, connect: false, sessionName: 'a', loadState: true, backend: null });
    expect(planOpen({ intent: 'bind', sessionName: 'b' }, boundToA)).toEqual({ close: true, wipeName: null, connect: true, sessionName: 'b', loadState: true, backend: null });
    expect(planOpen({ intent: 'bind', sessionName: 'a' }, unnamed)).toMatchObject({ close: true, connect: true, sessionName: 'a', loadState: true });
    expect(planOpen({ intent: 'bind', sessionName: 'a' }, dead)).toMatchObject({ close: false, connect: true, sessionName: 'a', loadState: true });
  });

  it('preflight-steps: always restarts, bound but without state, even when already bound', () => {
    expect(planOpen({ intent: 'preflight-steps', sessionName: 'a' }, boundToA)).toEqual({ close: true, wipeName: null, connect: true, sessionName: 'a', loadState: false, backend: null });
  });

  it('replay: wipes the persisted state between close and connect', () => {
    expect(planOpen({ intent: 'replay', sessionName: 'a' }, boundToA)).toEqual({ close: true, wipeName: 'a', connect: true, sessionName: 'a', loadState: false, backend: null });
    expect(planOpen({ intent: 'replay', sessionName: 'a' }, dead)).toMatchObject({ close: false, wipeName: 'a', connect: true });
  });

  describe('backend choice', () => {
    it('no opinion keeps a daemon on an override, and spawns new ones on the default', () => {
      expect(planOpen({ intent: 'reuse' }, onKernel)).toMatchObject({ close: false, connect: false, backend: null });
      expect(planOpen({ intent: 'bind', sessionName: 'a' }, boundToAOnKernel)).toMatchObject({ close: false, connect: false });
      expect(planOpen({ intent: 'fresh' }, onKernel)).toMatchObject({ close: true, connect: true, backend: null });
    });

    it('reuse restarts a daemon on another backend, unnamed, on the wanted one', () => {
      expect(planOpen({ intent: 'reuse', backend: 'kernel' }, unnamed)).toEqual({ close: true, wipeName: null, connect: true, sessionName: null, loadState: false, backend: 'kernel' });
      expect(planOpen({ intent: 'reuse', backend: null }, onKernel)).toEqual({ close: true, wipeName: null, connect: true, sessionName: null, loadState: false, backend: null });
      expect(planOpen({ intent: 'reuse', backend: 'kernel' }, onKernel)).toMatchObject({ close: false, connect: false, backend: 'kernel' });
      expect(planOpen({ intent: 'reuse', backend: null }, boundToA)).toMatchObject({ close: false, connect: false, sessionName: 'a' });
      expect(planOpen({ intent: 'reuse', backend: 'kernel' }, dead)).toMatchObject({ close: false, connect: true, backend: 'kernel' });
    });

    it('bind reuses only when both the name and the backend match', () => {
      expect(planOpen({ intent: 'bind', sessionName: 'a', backend: 'kernel' }, boundToAOnKernel)).toMatchObject({ close: false, connect: false, loadState: true, backend: 'kernel' });
      expect(planOpen({ intent: 'bind', sessionName: 'a', backend: 'kernel' }, boundToA)).toMatchObject({ close: true, connect: true, sessionName: 'a', loadState: true, backend: 'kernel' });
      expect(planOpen({ intent: 'bind', sessionName: 'a', backend: null }, boundToAOnKernel)).toMatchObject({ close: true, connect: true, sessionName: 'a', backend: null });
    });

    it('the restarting intents carry the backend through', () => {
      expect(planOpen({ intent: 'preflight-steps', sessionName: 'a', backend: 'cdp' }, boundToA)).toMatchObject({ close: true, connect: true, backend: 'cdp' });
      expect(planOpen({ intent: 'replay', sessionName: 'a', backend: 'cdp' }, dead)).toMatchObject({ connect: true, wipeName: 'a', backend: 'cdp' });
    });
  });
});
