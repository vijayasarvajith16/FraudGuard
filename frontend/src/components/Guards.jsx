import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/context.js';
import { IconShield } from './icons.jsx';

export function RequireAuth({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

/** Cosmetic: the alerting-service enforces the admin role on every /alerts/admin route. */
export function RequireAdmin({ children }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') {
    return (
      <section className="card empty-state rise">
        <span className="empty-icon tone-warn" aria-hidden="true">
          <IconShield size={26} />
        </span>
        <h1>Admins only</h1>
        <p className="muted">The review queue is available to administrators.</p>
      </section>
    );
  }
  return children;
}
