import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/context.js';
import { initials } from '../lib/stats.js';
import { IconActivity, IconBell, IconLogout, IconPlus, IconShield, IconWallet, LogoMark } from './icons.jsx';

const longDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const today = () => longDate.format(new Date());

function RailLink({ to, end, icon, label }) {
  return (
    <NavLink to={to} end={end} className="rail-link">
      {icon}
      <span className="rail-label">{label}</span>
    </NavLink>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [date] = useState(today);
  const isAdmin = user?.role === 'admin';
  return (
    <div className="shell">
      <aside className="rail">
        <NavLink to="/" end className="rail-logo" aria-label="FraudGuard home">
          <LogoMark size={30} />
        </NavLink>
        <nav aria-label="Main" className="rail-nav">
          <RailLink to="/" end icon={<IconWallet />} label="Wallet" />
          <RailLink to="/transactions" icon={<IconActivity />} label="Transactions" />
          <RailLink to="/alerts" icon={<IconBell />} label="Alerts" />
          {isAdmin && <RailLink to="/admin" icon={<IconShield />} label="Review queue" />}
        </nav>
        <div className="rail-foot">
          <span className="avatar" title={`${user?.name} · ${user?.email}`} aria-hidden="true">
            {initials(user?.name)}
          </span>
          <button type="button" className="rail-link rail-signout" onClick={() => logout()}>
            <IconLogout />
            <span className="rail-label">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-who">
            <p className="topbar-date">{date}</p>
            <p className="topbar-user muted small">
              {user?.name}
              {isAdmin && <span className="badge badge-ghost">admin</span>}
            </p>
          </div>
          <div className="topbar-actions">
            <Link
              to="/"
              state={{ focusSend: true }}
              className="round-btn"
              aria-label="New transfer"
              title="New transfer"
            >
              <IconPlus />
            </Link>
            <NavLink to="/alerts" className="round-btn" aria-label="Open alerts" title="Alerts">
              <IconBell />
            </NavLink>
          </div>
        </header>
        <main className="content" key={location.pathname}>
          <Outlet />
        </main>
        <footer className="footer muted small">
          FraudGuard demo. Notifications and OTP codes are simulated; the transactions use anonymised public card data.
        </footer>
      </div>
    </div>
  );
}
