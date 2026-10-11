// The Brand / Type chip filter (Screenshots, Diffs): pick any number of tag
// values; a row passes when its brand is among the picked brands (or none
// are picked) AND likewise for type. Tags live on the scenario, so callers
// pass the scenario's values and the full set of values to offer.

export interface TagSelection {
  brands: Set<string>;
  types: Set<string>;
}

export const NO_TAGS: TagSelection = { brands: new Set(), types: new Set() };

export function tagsActive(sel: TagSelection): number {
  return sel.brands.size + sel.types.size;
}

export function matchesTags(
  row: { brand?: string | null; type?: string | null },
  sel: TagSelection,
): boolean {
  const brandOk = sel.brands.size === 0 || (row.brand != null && sel.brands.has(row.brand));
  const typeOk = sel.types.size === 0 || (row.type != null && sel.types.has(row.type));
  return brandOk && typeOk;
}

/** Distinct, sorted values of one tag over a list of rows. */
export function tagValues(rows: { brand?: string | null; type?: string | null }[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function TagFilter({
  brands, types, selection, onChange,
}: {
  brands: string[];
  types: string[];
  selection: TagSelection;
  onChange: (next: TagSelection) => void;
}) {
  const active = tagsActive(selection);
  const toggle = (key: 'brands' | 'types', value: string) => {
    const next = new Set(selection[key]);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...selection, [key]: next });
  };
  const group = (label: string, key: 'brands' | 'types', values: string[]) => (
    <div className="filter-group">
      <div className="filter-group-label">{label}</div>
      {values.length === 0 ? (
        <span className="muted">No {label.toLowerCase()}s yet</span>
      ) : (
        <div className="chip-row">
          {values.map((v) => (
            <button
              key={v}
              type="button"
              className={`chip${selection[key].has(v) ? ' chip-on' : ''}`}
              onClick={() => toggle(key, v)}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <details className="filter-panel" open={active > 0}>
      <summary>
        Filter{' '}
        {active > 0 && <span className="filter-count">{active} active</span>}
      </summary>
      <div className="filter-body">
        {group('Brand', 'brands', brands)}
        {group('Type', 'types', types)}
        {active > 0 && (
          <button type="button" className="filter-clear" onClick={() => onChange(NO_TAGS)}>
            Clear filters
          </button>
        )}
      </div>
    </details>
  );
}
