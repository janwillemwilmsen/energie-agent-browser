import { describe, it, expect } from 'vitest';
import { matchesFilter, NO_FILTER } from './SnapshotPicker.js';

describe('snapshot tree filter', () => {
  const link = { role: 'link', name: 'Bereken je maandbedrag' };
  const heading = { role: 'heading', name: 'Bereken je maandbedrag' };

  it('matches everything when empty', () => {
    expect(matchesFilter(link, NO_FILTER)).toBe(true);
    expect(matchesFilter({ role: 'button', name: '' }, { role: '', text: '   ' })).toBe(true);
  });

  it('narrows by role exactly', () => {
    expect(matchesFilter(link, { role: 'link', text: '' })).toBe(true);
    expect(matchesFilter(heading, { role: 'link', text: '' })).toBe(false);
  });

  it('matches every word of the text against role or name, case-insensitively', () => {
    expect(matchesFilter(link, { role: '', text: 'MAAND' })).toBe(true);
    expect(matchesFilter(link, { role: '', text: 'bereken maand' })).toBe(true);
    expect(matchesFilter(link, { role: '', text: 'bereken knop' })).toBe(false);
    // The role counts as text too: "link" finds links without the dropdown.
    expect(matchesFilter(link, { role: '', text: 'link' })).toBe(true);
    expect(matchesFilter(heading, { role: '', text: 'link' })).toBe(false);
  });

  it('combines role and text', () => {
    expect(matchesFilter(heading, { role: 'heading', text: 'bereken' })).toBe(true);
    expect(matchesFilter(link, { role: 'heading', text: 'bereken' })).toBe(false);
  });
});
