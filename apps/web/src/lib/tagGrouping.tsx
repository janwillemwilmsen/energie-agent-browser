import type { ReactNode } from 'react';

// Shared "sort / group by tag" behaviour for the Dashboard, Scenarios and
// Runs pages, so the three views offer the same choices and behave the same:
//   date  → plain list in API order (most recent first)
//   brand → one group per Brand value
//   type  → one group per Type value
//   both  → one group per Brand + Type combination
// Groups are alphabetical with the untagged bucket last; item order inside a
// group keeps the API order.

export type GroupBy = 'date' | 'brand' | 'type' | 'both';

export interface Tagged {
  brand?: string | null;
  type?: string | null;
}

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string; title: string }[] = [
  { value: 'date', label: '☰ Date', title: 'Plain list, most recent first' },
  { value: 'brand', label: '⊞ Brand', title: 'Group by Brand tag' },
  { value: 'type', label: '⊞ Type', title: 'Group by Type tag' },
  { value: 'both', label: '⊞ Brand + Type', title: 'Group by Brand and Type tag combination' },
];

export function GroupBySwitch({
  value,
  onChange,
}: {
  value: GroupBy;
  onChange: (next: GroupBy) => void;
}) {
  return (
    <div className="view-switch" role="group" aria-label="Sort">
      {GROUP_BY_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`runs-view-toggle${value === o.value ? ' on' : ''}`}
          onClick={() => onChange(o.value)}
          title={o.title}
          aria-pressed={value === o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Identity of an item's group under the chosen mode. '' = untagged (sorted last).
export function groupKey(item: Tagged, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'date':
      return '';
    case 'brand':
      return item.brand ?? '';
    case 'type':
      return item.type ?? '';
    case 'both':
      return [item.brand, item.type].filter(Boolean).join(' · ');
  }
}

export function compareGroupKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

export interface TagGroup<T> {
  key: string;
  brand: string | null;
  type: string | null;
  items: T[];
}

// Bucket items by group (for card/grid views). Returns [] for 'date'.
export function groupByTag<T extends Tagged>(items: T[], groupBy: GroupBy): TagGroup<T>[] {
  if (groupBy === 'date') return [];
  const map = new Map<string, TagGroup<T>>();
  for (const it of items) {
    const key = groupKey(it, groupBy);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        brand: groupBy === 'type' ? null : it.brand ?? null,
        type: groupBy === 'brand' ? null : it.type ?? null,
        items: [],
      };
      map.set(key, g);
    }
    g.items.push(it);
  }
  return Array.from(map.values()).sort((a, b) => compareGroupKeys(a.key, b.key));
}

// Stable re-sort by group (for table views that render group header rows
// inline). 'date' returns the input order unchanged.
export function sortByGroup<T extends Tagged>(items: T[], groupBy: GroupBy): T[] {
  if (groupBy === 'date') return items;
  return items
    .map((it, i) => ({ it, i, k: groupKey(it, groupBy) }))
    .sort((a, b) => compareGroupKeys(a.k, b.k) || a.i - b.i)
    .map((x) => x.it);
}

// Header label for a group: coloured tag chips, or "No brand" / "No type" /
// "No tags" for the untagged bucket.
export function GroupLabel({
  groupBy,
  brand,
  type,
}: {
  groupBy: GroupBy;
  brand: string | null | undefined;
  type: string | null | undefined;
}): ReactNode {
  const showBrand = groupBy !== 'type' && !!brand;
  const showType = groupBy !== 'brand' && !!type;
  if (!showBrand && !showType) {
    return <span>{groupBy === 'both' ? 'No tags' : `No ${groupBy}`}</span>;
  }
  return (
    <span className="group-label-tags">
      {showBrand && <span className="tag tag-brand">{brand}</span>}
      {showType && <span className="tag tag-type">{type}</span>}
    </span>
  );
}
