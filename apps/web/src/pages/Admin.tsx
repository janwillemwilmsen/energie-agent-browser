import { Link } from 'react-router-dom';
import { ArrowRightLeft, Braces, Network, Terminal as TerminalIcon } from 'lucide-react';

// Admin landing page. Gathers lower-level / operational tools that don't belong
// in the main navigation. The Terminal lives here now instead of the top menu.
export function Admin() {
  return (
    <section>
      <h1>Admin</h1>
      <p className="muted">Lower-level and operational tools.</p>

      <div className="admin-links">
        <Link to="/terminal" className="admin-link">
          <TerminalIcon size={18} aria-hidden />
          <span>
            <strong>Terminal</strong>
            <span className="muted"> — bootstrap the agent-browser session and run commands</span>
          </span>
        </Link>
        <Link to="/admin/scenario-steps" className="admin-link">
          <Braces size={18} aria-hidden />
          <span>
            <strong>Raw scenario steps</strong>
            <span className="muted"> — inspect and hand-edit the underlying step rows</span>
          </span>
        </Link>
        <Link to="/admin/scenarios-io" className="admin-link">
          <ArrowRightLeft size={18} aria-hidden />
          <span>
            <strong>Export / import scenarios</strong>
            <span className="muted"> — copy scenarios between instances (e.g. dev → prod)</span>
          </span>
        </Link>
        <Link to="/admin/network" className="admin-link">
          <Network size={18} aria-hidden />
          <span>
            <strong>Network inspector</strong>
            <span className="muted"> — terminal + buttons to inspect the session's network traffic</span>
          </span>
        </Link>
      </div>
    </section>
  );
}
