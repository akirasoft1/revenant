import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { getMe, isUnauthenticated, isUnavailable, loginUrl } from '../api/client';
import type { Me } from '../api/types';
import { ME_KEY } from '../queryClient';

const MeContext = createContext<Me | null>(null);

/** The signed-in Discord user. Only valid under <AuthGate>. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe() used outside <AuthGate>');
  return me;
}

/** May this user write `memberId`'s hangar? (Same rule as the service: own, or admin.) */
export function canEdit(me: Me, memberId: string): boolean {
  return me.isAdmin || me.discordId === memberId;
}

const LOGIN_ERRORS: Record<string, string> = {
  denied: 'Discord sign-in was cancelled.',
  state_mismatch: 'That sign-in link expired or was opened in another browser. Please try again.',
  missing_code: 'Discord did not return a sign-in code. Please try again.',
  token_error: 'Discord rejected the sign-in. Please try again.',
  user_error: 'Could not read your Discord profile. Please try again.',
  server_error: 'Something went wrong signing you in. Please try again.',
  not_member: "Only members of the org's Discord server can use the hangar editor.",
  discord_unavailable: 'Discord is unavailable — try again shortly.',
};

export function loginErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return LOGIN_ERRORS[code] ?? `Sign-in failed (${code}). Please try again.`;
}

export function SignIn() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const error = loginErrorMessage(params.get('login_error'));
  params.delete('login_error');
  const rest = params.toString();
  const next = location.pathname + (rest ? `?${rest}` : '');
  return (
    <main className="landing">
      <div className="landing-card">
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true">◆</span> Org Hangar
        </h1>
        <p className="lead">
          Manage your Star Citizen ships and loadouts. The bot reads the same hangar, so changes show up in{' '}
          <code>/hangar list</code> right away.
        </p>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <a className="btn btn-discord" href={loginUrl(next)}>
          Sign in with Discord
        </a>
        <p className="muted small">Only your public Discord profile (name and avatar) is used.</p>
      </div>
    </main>
  );
}

function Unavailable() {
  return (
    <main className="landing">
      <div className="landing-card">
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true">◆</span> Org Hangar
        </h1>
        <p className="alert alert-warn" role="alert">
          Login is unavailable right now. Please try again later.
        </p>
      </div>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ME_KEY, queryFn: getMe, retry: false, staleTime: 5 * 60_000 });

  if (me.isPending) {
    return (
      <main className="landing">
        <p className="muted" role="status">
          Loading…
        </p>
      </main>
    );
  }
  if (me.isError) {
    if (isUnauthenticated(me.error)) return <SignIn />;
    if (isUnavailable(me.error)) return <Unavailable />;
    return (
      <main className="landing">
        <div className="landing-card">
          <p className="alert alert-error" role="alert">
            Could not reach the hangar service: {me.error.message}
          </p>
          <button className="btn" onClick={() => void me.refetch()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}
