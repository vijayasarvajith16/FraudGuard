import { Link, Route, Routes } from 'react-router';
import { RequireAdmin, RequireAuth } from './components/Guards.jsx';
import { Layout } from './components/Layout.jsx';
import { AdminPage } from './pages/AdminPage.jsx';
import { AlertsPage } from './pages/AlertsPage.jsx';
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { TransactionsPage } from './pages/TransactionsPage.jsx';

function NotFound() {
  return (
    <section className="card">
      <h1>Page not found</h1>
      <Link to="/">Back to your wallet</Link>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route
          path="admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
