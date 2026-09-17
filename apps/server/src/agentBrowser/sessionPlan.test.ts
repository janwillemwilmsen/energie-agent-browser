import { describe, it, expect } from 'vitest';
import { planOpen } from './sessionPlan.js';

const dead = { alive: false, boundName: null };
const unnamed = { alive: true, boundName: null };
const boundToA = { alive: true, boundName: 'a' };

describe('session open plan', () => {
  it('reuse: takes whatever is up, bootstraps unnamed otherwise', () => {
    expect(planOpen({ intent: 'reuse' }, boundToA)).toEqual({ close: false, wipeName: null, connect: false, sessionName: 'a', loadState: false });
    expect(planOpen({ intent: 'reuse' }, dead)).toEqual({ close: false, wipeName: null, connect: true, sessionName: null, loadState: false });
  });

  it('fresh: always a new unnamed daemon', () => {
    expect(planOpen({ intent: 'fresh' }, boundToA)).toMatchObject({ close: true, connect: true, sessionName: null, loadState: false });
    expect(planOpen({ intent: 'fresh' }, dead)).toMatchObject({ close: false, connect: true, sessionName: null });
  });

  it('bind: reuses a matching daemon (re-applying state), restarts a mismatched one', () => {
    expect(planOpen({ intent: 'bind', sessionName: 'a' }, boundToA)).toEqual({ close: false, wipeName: null, connect: false, sessionName: 'a', loadState: true });
    expect(planOpen({ intent: 'bind', sessionName: 'b' }, boundToA)).toEqual({ close: true, wipeName: null, connect: true, sessionName: 'b', loadState: true });
    expect(planOpen({ intent: 'bind', sessionName: 'a' }, unnamed)).toMatchObject({ close: true, connect: true, sessionName: 'a', loadState: true });
    expect(planOpen({ intent: 'bind', sessionName: 'a' }, dead)).toMatchObject({ close: false, connect: true, sessionName: 'a', loadState: true });
  });

  it('preflight-steps: always restarts, bound but without state, even when already bound', () => {
    expect(planOpen({ intent: 'preflight-steps', sessionName: 'a' }, boundToA)).toEqual({ close: true, wipeName: null, connect: true, sessionName: 'a', loadState: false });
  });

  it('replay: wipes the persisted state between close and connect', () => {
    expect(planOpen({ intent: 'replay', sessionName: 'a' }, boundToA)).toEqual({ close: true, wipeName: 'a', connect: true, sessionName: 'a', loadState: false });
    expect(planOpen({ intent: 'replay', sessionName: 'a' }, dead)).toMatchObject({ close: false, wipeName: 'a', connect: true });
  });
});
