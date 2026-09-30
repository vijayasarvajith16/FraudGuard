import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/context.js';

export function Layout() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand" end>
            <img src="/favicon.svg" alt="" width="22" height="22" />
            FraudGuard
          </NavLink>
          <nav aria-label="Main">
            <NavLink to="/" end>
              Wallet
            </NavLink>
            <NavLink to="/transactions">Transactions</NavLink>
            <NavLink to="/alerts">Alerts</NavLink>
            {isAdmin && <NavLink to="/admin">Review queue</NavLink>}
          </nav>
          <div className="user">
            <span className="user-name" title={user?.email}>
              {user?.name}
              {isAdmin && <span className="badge badge-muted">admin</span>}
            </span>
            <button type="button" className="btn-link" onClick={() => logout()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
      <footer className="footer muted small">
        FraudGuard demo. Notifications and OTP codes are simulated; the transactions use anonymised public card data.
      </footer>
    </div>
  );
}
