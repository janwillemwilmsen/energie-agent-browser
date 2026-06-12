import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import {
  CalendarClock,
  GitCompare,
  House,
  Images,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Settings,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { Home } from './pages/Home.js';
import { Scenarios } from './pages/Scenarios.js';
import { ScenarioEditor } from './pages/ScenarioEditor.js';
import { ScenarioTimeline } from './pages/ScenarioTimeline.js';
import { Terminal } from './pages/Terminal.js';
import { Schedules } from './pages/Schedules.js';
import { Runs } from './pages/Runs.js';
import { Diffs } from './pages/Diffs.js';
import { PreflightPage } from './pages/Preflight.js';
import { Screenshots } from './pages/Screenshots.js';
// Recordings pulls in Mediabunny (~400 kB) for video decode/playback — lazy-load
// it so that weight only ships when the user actually opens the page.
const Recordings = lazy(() =>
  import('./pages/Recordings.js').then((m) => ({ default: m.Recordings })),
);
import { Admin } from './pages/Admin.js';
import { AdminScenarioSteps } from './pages/AdminScenarioSteps.js';
import { AdminScenarioIO } from './pages/AdminScenarioIO.js';
import { AdminNetwork } from './pages/AdminNetwork.js';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

// `end` on the Home link so it only highlights for the exact "/" path; the
// other routes match by prefix (NavLink default), so e.g. /scenarios/12 still
// lights up the Scenarios link.
const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/scenarios', label: 'Scenarios', icon: Workflow },
  { to: '/preflight', label: 'Preflights', icon: KeyRound },
  { to: '/schedules', label: 'Schedules', icon: CalendarClock },
  { to: '/runs', label: 'Runs', icon: Play },
  { to: '/screenshots', label: 'Screenshots', icon: Images },
  { to: '/recordings', label: 'Recordings', icon: Video },
  { to: '/diffs', label: 'Diffs', icon: GitCompare },
];

const COLLAPSE_KEY = 'eab.nav.collapsed';

export function App() {
  // Persist the collapsed state so the sidebar stays how the user left it.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore — storage may be unavailable (private mode, etc.) */
    }
  }, [collapsed]);

  return (
    <div className={`app${collapsed ? ' app-collapsed' : ''}`}>
      <nav className={`nav${collapsed ? ' nav-collapsed' : ''}`}>
        <button
          type="button"
          className="nav-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
        >
          {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          {!collapsed && <span className="nav-label">Collapse</span>}
        </button>
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => (isActive ? 'nav-active' : undefined)}
            title={collapsed ? label : undefined}
          >
            <Icon size={20} className="nav-icon" aria-hidden />
            {!collapsed && <span className="nav-label">{label}</span>}
          </NavLink>
        ))}
        {/* Admin sits at the bottom of the sidebar (pushed down via margin-top
            auto in CSS) and uses a smaller font than the main links. */}
        <NavLink
          to="/admin"
          className={({ isActive }) => `nav-admin${isActive ? ' nav-active' : ''}`}
          title={collapsed ? 'Admin' : undefined}
        >
          <Settings size={18} className="nav-icon" aria-hidden />
          {!collapsed && <span className="nav-label">Admin</span>}
        </NavLink>
      </nav>
      <main className="main">
        <Suspense fallback={<p className="muted">Loading…</p>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/scenarios" element={<Scenarios />} />
          <Route path="/scenarios/:id" element={<ScenarioEditor />} />
          <Route path="/screenshots/timeline/:id" element={<ScenarioTimeline />} />
          <Route path="/terminal" element={<Terminal />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/scenario-steps" element={<AdminScenarioSteps />} />
          <Route path="/admin/scenarios-io" element={<AdminScenarioIO />} />
          <Route path="/admin/network" element={<AdminNetwork />} />
          <Route path="/preflight" element={<PreflightPage />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/screenshots" element={<Screenshots />} />
          <Route path="/recordings" element={<Recordings />} />
          <Route path="/diffs" element={<Diffs />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
