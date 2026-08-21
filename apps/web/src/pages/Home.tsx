import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { api, type ScenarioCard } from '../lib/api.js';
import { GroupBySwitch, GroupLabel, groupByTag, type GroupBy } from '../lib/tagGrouping.js';

export function Home() {
  const [cards, setCards] = useState<ScenarioCard[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  // 'date' → one flat grid in API order (updated_at DESC). Otherwise a
  // section per Brand / Type / Brand+Type value, alphabetical, untagged last
  // (shared with /scenarios and /runs via lib/tagGrouping).
  const [groupBy, setGroupBy] = useState<GroupBy>('date');

  useEffect(() => {
    api
      .listScenarioCards()
      .then(setCards)
      .catch((e) => setErr(e.message));
  }, []);

  const brands = useMemo(() => collectTagValues(cards, 'brand'), [cards]);
  const types = useMemo(() => collectTagValues(cards, 'type'), [cards]);

  const visible = useMemo(() => {
    return cards.filter((c) => {
      const brandOk = selectedBrands.size === 0 || (c.brand && selectedBrands.has(c.brand));
      const typeOk = selectedTypes.size === 0 || (c.type && selectedTypes.has(c.type));
      return brandOk && typeOk;
    });
  }, [cards, selectedBrands, selectedTypes]);

  // Grouped view: cards bucketed by the chosen tag value(s), groups sorted
  // alphabetically with the untagged bucket last. Card order inside a group
  // keeps the API order (updated_at DESC).
  const groups = useMemo(() => groupByTag(visible, groupBy), [visible, groupBy]);

  function toggle(set: Set<string>, value: string, setter: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const activeFilterCount = selectedBrands.size + selectedTypes.size;

  return (
    <section>
      <div className="runs-head">
        <h1>Dashboard</h1>
        <GroupBySwitch value={groupBy} onChange={setGroupBy} />
      </div>
      {err && <p className="error">{err}</p>}

      <details className="filter-panel" open={activeFilterCount > 0}>
        <summary>
          Filter{' '}
          {activeFilterCount > 0 && (
            <span className="filter-count">{activeFilterCount} active</span>
          )}
        </summary>
        <div className="filter-body">
          <div className="filter-group">
            <div className="filter-group-label">Brand</div>
            {brands.length === 0 ? (
              <span className="muted">No brands yet</span>
            ) : (
              <div className="chip-row">
                {brands.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`chip${selectedBrands.has(b) ? ' chip-on' : ''}`}
                    onClick={() => toggle(selectedBrands, b, setSelectedBrands)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="filter-group">
            <div className="filter-group-label">Type</div>
            {types.length === 0 ? (
              <span className="muted">No types yet</span>
            ) : (
              <div className="chip-row">
                {types.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip${selectedTypes.has(t) ? ' chip-on' : ''}`}
                    onClick={() => toggle(selectedTypes, t, setSelectedTypes)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="filter-clear"
              onClick={() => {
                setSelectedBrands(new Set());
                setSelectedTypes(new Set());
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </details>

      {cards.length === 0 ? (
        <p className="muted" style={{ marginTop: 24 }}>
          No scenarios yet. Create one on the <Link to="/scenarios">Scenarios</Link> page.
        </p>
      ) : visible.length === 0 ? (
        <p className="muted" style={{ marginTop: 24 }}>
          No scenarios match the current filters.
        </p>
      ) : groupBy !== 'date' ? (
        groups.map((g) => (
          <div key={g.key || '(untagged)'}>
            <div className="card-group-head">
              <GroupLabel groupBy={groupBy} brand={g.brand} type={g.type} />
              <span className="muted">
                {g.items.length} scenario{g.items.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="card-grid">
              {g.items.map((c) => (
                <ScenarioCardView key={c.id} card={c} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="card-grid">
          {visible.map((c) => (
            <ScenarioCardView key={c.id} card={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function ScenarioCardView({ card }: { card: ScenarioCard }) {
  // ?w/&h ask the server for a cached WebP thumbnail cover-cropped from the
  // top — matching this card's 16:10 `object-fit: cover; object-position: top`
  // box — instead of the multi-MB full-page original.
  const thumb =
    card.latest_run_id != null && card.latest_screenshot
      ? `/api/runs/${card.latest_run_id}/screenshots/${encodeURIComponent(card.latest_screenshot)}?w=480&h=300`
      : null;

  // The card body links to the timeline; the cog is a SIBLING link (nested
  // anchors are invalid HTML), floated over the thumb corner via CSS.
  return (
    <div className="scenario-card">
      <Link to={`/screenshots/timeline/${card.id}`} className="scenario-card-link">
        <div className="scenario-card-thumb">
          {thumb ? (
            <img src={thumb} alt={`Latest run of ${card.name}`} loading="lazy" decoding="async" />
          ) : (
            <div className="scenario-card-thumb-empty">No runs yet</div>
          )}
        </div>
        <div className="scenario-card-body">
          <div className="scenario-card-title">{card.name}</div>
          <div className="scenario-card-tags">
            {card.brand && <span className="tag tag-brand">{card.brand}</span>}
            {card.type && <span className="tag tag-type">{card.type}</span>}
          </div>
          {card.latest_run_started_at && (
            <div className="scenario-card-meta">
              Last run {formatDate(card.latest_run_started_at)}
              {card.latest_run_status && (
                <span className={`status status-${card.latest_run_status}`} style={{ marginLeft: 8 }}>
                  {card.latest_run_status}
                </span>
              )}
            </div>
          )}
        </div>
      </Link>
      <Link
        to={`/scenarios/${card.id}`}
        className="scenario-card-edit"
        title={`Edit scenario "${card.name}"`}
        aria-label={`Edit scenario "${card.name}"`}
      >
        <Settings size={16} aria-hidden />
      </Link>
    </div>
  );
}

function collectTagValues(cards: ScenarioCard[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const c of cards) {
    const v = c[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
