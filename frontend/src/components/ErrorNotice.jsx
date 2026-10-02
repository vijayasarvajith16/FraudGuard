import { IconBan } from './icons.jsx';

/** Shows an ApiError (contracts §0.5): message, per-field details, and the request ID for support. */
export function ErrorNotice({ error, children }) {
  if (!error) return null;
  const details = (error.details ?? []).filter((d) => d.field || d.issue);
  return (
    <div className="notice notice-error" role="alert">
      <IconBan size={18} />
      <div>
        <p>{children ?? error.message}</p>
        {details.length > 0 && (
          <ul>
            {details.map((d, i) => (
              <li key={i}>{d.field ? `${d.field}: ${d.issue}` : d.issue}</li>
            ))}
          </ul>
        )}
        {error.requestId && <p className="muted small">Request ID {error.requestId}</p>}
      </div>
    </div>
  );
}
