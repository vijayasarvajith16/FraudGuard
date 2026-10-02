import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/context.js';
import { TierBadge } from '../components/Badges.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { IconLayers, IconScan, IconSliders, LogoMark } from '../components/icons.jsx';
import { usePageTitle } from '../hooks/usePageTitle.js';

const STAGES = [
  { name: 'Quick scan', text: 'Every transfer, in milliseconds', icon: IconScan },
  { name: 'Deep scan', text: 'Only the flagged ones', icon: IconLayers },
  { name: 'Mitigation', text: 'Log, notify, one-time code or freeze', icon: IconSliders },
];

function AuthShell({ title, subtitle, children }) {
  return (
    <main className="auth">
      <section className="auth-hero" aria-label="About FraudGuard">
        <div className="brand brand-large">
          <LogoMark size={34} />
          FraudGuard
        </div>
        <p className="auth-headline">Every transfer is screened before any money moves.</p>
        <ol className="auth-flow">
          {STAGES.map(({ name, text, icon: Glyph }) => (
            <li key={name}>
              <span className="auth-node" aria-hidden="true">
                <Glyph size={20} />
              </span>
              <span>
                <strong>{name}</strong>
                <span className="muted small">{text}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="auth-tiers" aria-label="Risk tiers">
          {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((tier) => (
            <TierBadge key={tier} tier={tier} />
          ))}
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <h1>{title}</h1>
          <p className="muted">{subtitle}</p>
          {children}
        </div>
      </section>
    </main>
  );
}

export function LoginPage() {
  usePageTitle('Sign in');
  const { user, login, notice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={location.state?.from ?? '/'} replace />;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Send money with real-time fraud screening.">
      {notice && (
        <p className="notice notice-warn" role="status">
          {notice}
        </p>
      )}
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      <ErrorNotice error={error}>
        {error?.code === 'INVALID_CREDENTIALS' ? 'Wrong email or password.' : error?.message}
      </ErrorNotice>
      <p className="muted small auth-switch">
        New here? <Link to="/register">Create an account</Link>
      </p>
    </AuthShell>
  );
}

export function RegisterPage() {
  usePageTitle('Create account');
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({ name: form.name.trim(), email: form.email.trim(), password: form.password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create an account"
      subtitle="Accounts start with an empty wallet; add demo funds after signing in."
    >
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Name</span>
          <input name="name" autoComplete="name" required maxLength={80} value={form.name} onChange={set('name')} />
        </label>
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </label>
        <div className="field">
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
            value={form.password}
            onChange={set('password')}
            aria-describedby="password-hint"
          />
          <span id="password-hint" className="muted small">
            8 to 128 characters, with at least one letter and one digit.
          </span>
        </div>
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Creating account...' : 'Create account'}
        </button>
      </form>
      <ErrorNotice error={error}>
        {error?.code === 'EMAIL_TAKEN' ? 'An account with this email already exists.' : error?.message}
      </ErrorNotice>
      <p className="muted small auth-switch">
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}
