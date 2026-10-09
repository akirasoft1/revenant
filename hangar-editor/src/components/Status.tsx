import { ApiError } from '../api/client';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'limit') {
      const limit = typeof err.body.limit === 'number' ? err.body.limit : null;
      const count = typeof err.body.shipCount === 'number' ? err.body.shipCount : null;
      return limit != null
        ? `Hangar limit reached: at most ${limit} ships per member${count != null ? ` (this hangar has ${count})` : ''}. Remove a ship first.`
        : `Hangar limit reached: ${err.message}`;
    }
    if (err.code === 'busy') return 'The importer is busy — try again in a moment.';
    if (err.code === 'too_large') return `Too large: ${err.message}`;
    if (err.status === 403) return `Not allowed: ${err.message}`;
    if (err.status === 503) return `Temporarily unavailable: ${err.message}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="alert alert-error" role="alert">
      <span>{errorText(error)}</span>
      {onRetry && (
        <button className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
