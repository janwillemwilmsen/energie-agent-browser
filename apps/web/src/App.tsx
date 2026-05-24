import { Link, Route, Routes, Navigate } from 'react-router-dom';
import { Scenarios } from './pages/Scenarios.js';
import { ScenarioEditor } from './pages/ScenarioEditor.js';
import { Terminal } from './pages/Terminal.js';
import { Schedules } from './pages/Schedules.js';
import { Runs } from './pages/Runs.js';

export function App() {
  return (
    <div className="app">
      <nav className="nav">
        <Link to="/scenarios">Scenarios</Link>
        <Link to="/terminal">Terminal</Link>
        <Link to="/schedules">Schedules</Link>
        <Link to="/runs">Runs</Link>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/scenarios" replace />} />
          <Route path="/scenarios" element={<Scenarios />} />
          <Route path="/scenarios/:id" element={<ScenarioEditor />} />
          <Route path="/terminal" element={<Terminal />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/runs" element={<Runs />} />
        </Routes>
      </main>
    </div>
  );
}
