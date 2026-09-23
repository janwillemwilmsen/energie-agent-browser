import { describe, it, expect } from 'vitest';
import { draftMove, draftReorder, draftToEditable, editableToDraft } from './store.js';
import { summarizeStep } from './summarize.js';

type Step = { kind: string } & Record<string, unknown>;
const nav: Step = { kind: 'navigate', url: 'https://a.test/' };
const click: Step = { kind: 'click', selector: { role: 'button', name: 'Go' } };
const wait: Step = { kind: 'wait', ms: 500 };

describe('draft step store', () => {
  it('moves a step up or down and ignores moves past the ends', () => {
    expect(draftMove([nav, click, wait], 1, 'up')).toEqual([click, nav, wait]);
    expect(draftMove([nav, click, wait], 1, 'down')).toEqual([nav, wait, click]);
    expect(draftMove([nav, click, wait], 0, 'up')).toEqual([nav, click, wait]);
    expect(draftMove([nav, click, wait], 2, 'down')).toEqual([nav, click, wait]);
  });

  it('reorders by a full permutation and rejects anything else', () => {
    expect(draftReorder([nav, click, wait], [2, 0, 1])).toEqual([wait, nav, click]);
    expect(draftReorder([nav, click, wait], [2, 0])).toEqual([nav, click, wait]);
    expect(draftReorder([nav, click, wait], [0, 0, 1])).toEqual([nav, click, wait]);
    expect(draftReorder([nav, click, wait], [0, 1, 3])).toEqual([nav, click, wait]);
  });

  it('splits a draft step into kind + payload and rebuilds it through the schema', () => {
    const row = draftToEditable(click, 3);
    expect(row).toEqual({ id: 3, kind: 'click', payload: { selector: { role: 'button', name: 'Go' } } });
    expect(editableToDraft<Step>(row.kind, row.payload)).toEqual(click);
    expect(() => editableToDraft<Step>('wait', { ms: -1 })).toThrow(/invalid wait step at ms/);
    expect(() => editableToDraft<Step>('auth-login', {})).toThrow(/invalid auth-login step at name/);
  });
});

describe('summarizeStep', () => {
  it('describes selectors by locator when present, else role + name', () => {
    expect(summarizeStep('click', { selector: { role: 'button', name: 'Go' } })).toBe('button "Go"');
    expect(summarizeStep('click', { selector: { role: '', name: '', locator: '#go' } })).toBe('#go');
    expect(summarizeStep('type', { selector: { role: 'textbox', name: 'Email', ordinal: 1 }, text: 'a@b' }))
      .toBe('textbox "Email" #1 "a@b"');
    expect(summarizeStep('select', { selector: { role: 'combobox', name: 'Land' }, value: 'NL' }))
      .toBe('combobox "Land" → "NL"');
    expect(summarizeStep('check', { selector: { role: '', name: '', find: { by: 'role', value: 'checkbox', name: 'Zonnepanelen', exact: true } } }))
      .toBe('find role "checkbox" name "Zonnepanelen" (exact)');
    expect(summarizeStep('fill', { selector: { role: '', name: '', find: { by: 'label', value: 'Email' } }, value: 'a@b' }))
      .toBe('find label "Email" "a@b"');
    expect(summarizeStep('press', { key: 'Control+a' })).toBe('⌨ Control+a');
  });

  it('describes the run-shaped kinds', () => {
    expect(summarizeStep('screenshot', { label: 'home', fullPage: true, format: 'webp', quality: 70 }))
      .toBe('home (full) (webp q70)');
    expect(summarizeStep('scroll', { toBottom: true })).toBe('to bottom (lazy-load)');
    expect(summarizeStep('scroll', { dy: -300 })).toBe('up 300px');
    expect(summarizeStep('wait', { ms: 250 })).toBe('250ms');
    expect(summarizeStep('wait', { selector: { role: 'dialog', name: 'Cookies' } })).toBe('for dialog "Cookies"');
    expect(summarizeStep('auth-login', { name: 'acme' })).toBe('🔐 auth profile "acme"');
    expect(summarizeStep('mystery', { x: 1 })).toBe('{"x":1}');
  });
});
