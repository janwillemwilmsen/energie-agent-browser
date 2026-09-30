import { getDb } from '../db/index.js';

// Preset prompts for the Ask page. Live in ask_presets so the user can edit
// and add their own; the built-in set is seeded on first read.

export interface Preset {
  id: number;
  label: string;
  prompt: string;
  position: number;
}

const DEFAULT_PRESETS: { label: string; prompt: string }[] = [
  {
    label: 'Conversion review',
    prompt:
      'Review this funnel for conversion. Rank the findings by expected impact; for each, name the screenshot and location, explain why it matters, and propose a concrete change (rewrite copy in Dutch where copy is the issue).',
  },
  {
    label: 'Copy critique',
    prompt:
      'Critique the copy: headlines, subheads, CTAs, form labels, microcopy and error/help text. Quote the current text, explain the problem, and give a rewritten version in Dutch that keeps the brand tone.',
  },
  {
    label: 'Above the fold',
    prompt:
      'Look only at the first screenshot (part 1) of each scenario. Is the value proposition clear within 5 seconds? What would you change in the hero: headline, supporting line, primary CTA, trust elements?',
  },
  {
    label: 'Form friction',
    prompt:
      'Audit every form step for friction: number of fields, unclear labels, missing defaults, validation, progress indication, and moments where the user might abandon. Suggest the minimum-friction version of each step.',
  },
  {
    label: 'Compare scenarios',
    prompt:
      'Compare the scenarios side by side: value proposition, trust, price presentation, form friction, CTA clarity. For each dimension say who does it best and what the others should borrow. End with a scored table.',
  },
  {
    label: 'Mobile issues',
    prompt:
      'Focus on the mobile screenshots. List layout, tap-target, readability and ordering problems, and what the desktop version does that mobile loses.',
  },
];

export function listPresets(): Preset[] {
  const db = getDb();
  const count = (db.prepare('SELECT count(*) c FROM ask_presets').get() as { c: number }).c;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO ask_presets (label, prompt, position) VALUES (?, ?, ?)');
    DEFAULT_PRESETS.forEach((p, i) => ins.run(p.label, p.prompt, i));
  }
  return db.prepare('SELECT id, label, prompt, position FROM ask_presets ORDER BY position, id').all() as Preset[];
}

export function createPreset(label: string, prompt: string): Preset {
  const db = getDb();
  const max = (db.prepare('SELECT coalesce(max(position), -1) m FROM ask_presets').get() as { m: number }).m;
  const info = db.prepare('INSERT INTO ask_presets (label, prompt, position) VALUES (?, ?, ?)').run(label, prompt, max + 1);
  return db.prepare('SELECT id, label, prompt, position FROM ask_presets WHERE id = ?').get(info.lastInsertRowid) as Preset;
}

export function updatePreset(id: number, patch: { label?: string; prompt?: string; position?: number }): Preset | null {
  const db = getDb();
  const cur = db.prepare('SELECT id, label, prompt, position FROM ask_presets WHERE id = ?').get(id) as Preset | undefined;
  if (!cur) return null;
  db.prepare('UPDATE ask_presets SET label = ?, prompt = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(patch.label ?? cur.label, patch.prompt ?? cur.prompt, patch.position ?? cur.position, id);
  return db.prepare('SELECT id, label, prompt, position FROM ask_presets WHERE id = ?').get(id) as Preset;
}

export function deletePreset(id: number): boolean {
  return getDb().prepare('DELETE FROM ask_presets WHERE id = ?').run(id).changes > 0;
}
