import { api } from './api.js';

// Colour schemes. The whole UI paints through the custom properties on :root
// (styles.css); a scheme is a set of values for them, applied inline on the
// <html> element so the stylesheet needs no per-theme blocks. The default
// scheme is the stylesheet's own values (nothing applied). All schemes are
// dark: the few hard-coded colours left in the stylesheet (status badges,
// the fold line, …) assume a dark base.

export type ThemeVar = 'bg' | 'panel' | 'text' | 'muted' | 'border' | 'accent' | 'error' | 'canvas' | 'on-accent';

export interface Theme {
  id: string;
  name: string;
  description: string;
  vars: Record<ThemeVar, string>;
}

export const DEFAULT_THEME = 'slate';

export const THEMES: Theme[] = [
  {
    id: 'slate',
    name: 'Slate',
    description: 'The original: slate blue-grey with a sky accent.',
    vars: { bg: '#0f172a', panel: '#1e293b', text: '#e2e8f0', muted: '#94a3b8', border: '#334155', accent: '#38bdf8', error: '#f87171', canvas: '#0b1120', 'on-accent': '#0f172a' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Neutral greys with an emerald accent.',
    vars: { bg: '#18181b', panel: '#27272a', text: '#e4e4e7', muted: '#a1a1aa', border: '#3f3f46', accent: '#34d399', error: '#f87171', canvas: '#111113', 'on-accent': '#0b1a14' },
  },
  {
    id: 'navy',
    name: 'Navy & amber',
    description: 'Deep navy with a warm amber accent.',
    vars: { bg: '#0c1a2b', panel: '#132a44', text: '#e6edf5', muted: '#8fa3bb', border: '#23405f', accent: '#fbbf24', error: '#fb7185', canvas: '#081220', 'on-accent': '#1f1600' },
  },
  {
    id: 'plum',
    name: 'Plum',
    description: 'Aubergine tones with a violet accent.',
    vars: { bg: '#1a1326', panel: '#27193a', text: '#ece6f5', muted: '#a89bbd', border: '#3d2d57', accent: '#c084fc', error: '#f87171', canvas: '#120d1b', 'on-accent': '#1a0b2e' },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Dark green with a lime accent.',
    vars: { bg: '#0f1a14', panel: '#1a2a21', text: '#e3ece6', muted: '#93a89b', border: '#2f4a3a', accent: '#a3e635', error: '#fb7185', canvas: '#0a120e', 'on-accent': '#13200a' },
  },
  {
    id: 'mono',
    name: 'Monochrome',
    description: 'Almost black with greys only — the accent is a light grey.',
    vars: { bg: '#0a0a0a', panel: '#171717', text: '#e5e5e5', muted: '#8a8a8a', border: '#2e2e2e', accent: '#d4d4d4', error: '#f87171', canvas: '#050505', 'on-accent': '#0a0a0a' },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    description: 'Charcoal greys, a shade lighter than Monochrome, with a mid-grey accent.',
    vars: { bg: '#1c1c1c', panel: '#262626', text: '#ececec', muted: '#9c9c9c', border: '#3a3a3a', accent: '#a3a3a3', error: '#f87171', canvas: '#121212', 'on-accent': '#111111' },
  },
];

const CACHE_KEY = 'eab.theme';

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

/** Paint a scheme: its values on :root (the default clears them, back to the stylesheet). */
export function applyTheme(id: string | null | undefined): void {
  const theme = themeById(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) {
    if (theme.id === DEFAULT_THEME) root.style.removeProperty(`--${k}`);
    else root.style.setProperty(`--${k}`, v);
  }
  root.dataset.theme = theme.id;
  try { localStorage.setItem(CACHE_KEY, theme.id); } catch { /* ignore */ }
}

/** The last applied scheme, from this browser's cache: painted before the server answers. */
export function cachedTheme(): string {
  try { return localStorage.getItem(CACHE_KEY) ?? DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}

/** The stored scheme (server-side setting, shared by every browser), applied. */
export async function loadTheme(): Promise<string> {
  const { theme } = await api.getTheme();
  const id = themeById(theme).id;
  applyTheme(id);
  return id;
}
