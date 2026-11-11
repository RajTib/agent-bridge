import { useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setPassword('');
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError(`Too many login attempts. ${err.message !== `Request failed (429)` ? err.message : 'Wait a minute and try again.'}`);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="brand brand-lg">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M6 20c3-8 17-8 20 0" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <circle cx="9" cy="22" r="3" className="brand-dot-a" />
            <circle cx="23" cy="22" r="3" className="brand-dot-b" />
          </svg>
          <span className="wordmark">
            Agent<strong>Bridge</strong>
          </span>
        </div>
        <p className="muted login-sub">Approve your coding agent from anywhere.</p>

        <label htmlFor="password" className="field-label">
          Dashboard password
        </label>
        <input
          id="password"
          type="password"
          className="input"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'login-error' : undefined}
        />

        {error ? (
          <p id="login-error" className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
