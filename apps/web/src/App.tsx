import { Link, Route, Routes } from 'react-router-dom';
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

export function App() {
  return (
    <div className="app">
      <nav className="nav">
        <Link to="/">Home</Link>
        <Link to="/scenarios">Scenarios</Link>
        <Link to="/preflight">Preflights</Link>
        <Link to="/terminal">Terminal</Link>
        <Link to="/schedules">Schedules</Link>
        <Link to="/runs">Runs</Link>
        <Link to="/screenshots">Screenshots</Link>
        <Link to="/diffs">Diffs</Link>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/scenarios" element={<Scenarios />} />
          <Route path="/scenarios/:id" element={<ScenarioEditor />} />
          <Route path="/scenarios/:id/timeline" element={<ScenarioTimeline />} />
          <Route path="/terminal" element={<Terminal />} />
          <Route path="/preflight" element={<PreflightPage />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/screenshots" element={<Screenshots />} />
          <Route path="/diffs" element={<Diffs />} />
        </Routes>
      </main>
    </div>
  );
}
