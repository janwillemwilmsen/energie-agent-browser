import { useState } from 'react';
import { api } from '../lib/api.js';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.authLogin(username.trim(), password);
      onSuccess();
    } catch {
      // The endpoint returns 401 on bad credentials; keep the message generic.
      setError('Incorrect login or passphrase.');
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%',
          maxWidth: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 24,
          border: '1px solid var(--border, rgba(127,127,127,0.25))',
          borderRadius: 12,
          background: 'var(--panel, rgba(127,127,127,0.06))',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>Sign in</h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          This app is protected. Enter your login and passphrase to continue.
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Login</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Passphrase</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ marginTop: 4 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
