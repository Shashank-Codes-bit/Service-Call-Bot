import { useState, type FormEvent } from 'react';
import { api, type Me } from '../api.ts';
import { useAction } from '../ui.tsx';

/** Sign in, or open a new centre. Nothing else is reachable without one. */
export function Gate({ onIn }: { onIn: (me: Me, fresh: boolean) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const { busy, error, setError, run } = useAction();
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [centre, setCentre] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const me =
      mode === 'in'
        ? await run(() => api.login(userId, password))
        : await run(() => api.signup(centre, userId.trim().toLowerCase(), password));
    if (me) onIn(me, mode === 'up');
  }

  const swap = (m: 'in' | 'up') => {
    setMode(m);
    setError(undefined);
  };

  return (
    <div className="gate">
      <form onSubmit={submit} aria-label={mode === 'in' ? 'Sign in' : 'Create a centre'}>
        {mode === 'in' ? (
          <>
            <h1>Service desk</h1>
            <p className="muted">Sign in to your centre.</p>
          </>
        ) : (
          <>
            <h1>Create a centre</h1>
            <p className="muted">
              Your centre opens with sample customers, bookings and follow-ups, so you can try everything straight away.
            </p>
            <div className="pair" style={{ display: 'grid', gap: 4 }}>
              <label className="small" style={{ fontWeight: 600 }} htmlFor="su-name">
                Centre name
              </label>
              <input className="field" id="su-name" required value={centre} onChange={(e) => setCentre(e.target.value)} placeholder="e.g. Sharma Motors, Indore" />
            </div>
          </>
        )}
        <div className="pair" style={{ display: 'grid', gap: 4 }}>
          <label className="small" style={{ fontWeight: 600 }} htmlFor="uid">
            User ID
          </label>
          <input
            className="field"
            id="uid"
            autoComplete="username"
            autoCapitalize="none"
            required
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder={mode === 'up' ? 'e.g. sharma-indore' : ''}
          />
          {mode === 'up' && <span className="muted small">Lowercase letters, numbers and hyphens.</span>}
        </div>
        <div className="pair" style={{ display: 'grid', gap: 4 }}>
          <label className="small" style={{ fontWeight: 600 }} htmlFor="pw">
            Password
          </label>
          <input
            className="field"
            id="pw"
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'up' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'up' ? 'At least 8 characters' : ''}
          />
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? (mode === 'in' ? 'Signing in…' : 'Setting up…') : mode === 'in' ? 'Sign in' : 'Create centre'}
        </button>
        {mode === 'in' ? (
          <span className="switch">
            Stays signed in on this device for 12 hours. New centre?{' '}
            <button type="button" className="linklike" onClick={() => swap('up')}>
              Create an account
            </button>
          </span>
        ) : (
          <span className="switch">
            Each centre’s data is kept separate.{' '}
            <button type="button" className="linklike" onClick={() => swap('in')}>
              Back to sign in
            </button>
          </span>
        )}
      </form>
    </div>
  );
}
