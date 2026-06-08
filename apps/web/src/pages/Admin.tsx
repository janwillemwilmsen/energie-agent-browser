import { Link } from 'react-router-dom';
import { Terminal as TerminalIcon } from 'lucide-react';

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
      </div>
    </section>
  );
}
