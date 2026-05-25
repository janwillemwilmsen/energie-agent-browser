import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ScenarioCard } from '../lib/api.js';

export function Home() {
  const [cards, setCards] = useState<ScenarioCard[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

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

  function toggle(set: Set<string>, value: string, setter: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const activeFilterCount = selectedBrands.size + selectedTypes.size;

  return (
    <section>
      <h1>Dashboard</h1>
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
  const thumb =
    card.latest_run_id != null && card.latest_screenshot
      ? `/api/runs/${card.latest_run_id}/screenshots/${encodeURIComponent(card.latest_screenshot)}`
      : null;

  return (
    <Link to={`/scenarios/${card.id}/timeline`} className="scenario-card">
      <div className="scenario-card-thumb">
        {thumb ? (
          <img src={thumb} alt={`Latest run of ${card.name}`} loading="lazy" />
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
