import { Link, Route, Routes } from 'react-router-dom';
import { Home } from './pages/Home.js';
import { Scenarios } from './pages/Scenarios.js';
import { ScenarioEditor } from './pages/ScenarioEditor.js';
import { ScenarioTimeline } from './pages/ScenarioTimeline.js';
import { Terminal } from './pages/Terminal.js';
import { Schedules } from './pages/Schedules.js';
import { Runs } from './pages/Runs.js';

export function App() {
  return (
    <div className="app">
      <nav className="nav">
        <Link to="/">Home</Link>
        <Link to="/scenarios">Scenarios</Link>
        <Link to="/terminal">Terminal</Link>
        <Link to="/schedules">Schedules</Link>
        <Link to="/runs">Runs</Link>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/scenarios" element={<Scenarios />} />
          <Route path="/scenarios/:id" element={<ScenarioEditor />} />
          <Route path="/scenarios/:id/timeline" element={<ScenarioTimeline />} />
          <Route path="/terminal" element={<Terminal />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/runs" element={<Runs />} />
        </Routes>
      </main>
    </div>
  );
}
