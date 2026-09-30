import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/context.js';

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
      <section className="card">
        <h1>Admins only</h1>
        <p className="muted">The review queue is available to administrators.</p>
      </section>
    );
  }
  return children;
}
