import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate, useMe } from './AuthGate';
import { App } from '../App';
import { ME, mockFetch, renderWithProviders } from '../test/utils';

function Secret() {
  const me = useMe();
  return <p>hello {me.username}</p>;
}

describe('AuthGate', () => {
  it('shows "Sign in with Discord" on 401, linking back to the current path', async () => {
    mockFetch({ 'GET /api/me': { status: 401, body: { error: 'unauthenticated', message: 'no session' } } });
    renderWithProviders(
      <AuthGate>
        <Secret />
      </AuthGate>,
      { route: '/members/222?tab=x' },
    );
    const link = await screen.findByRole('link', { name: 'Sign in with Discord' });
    expect(link).toHaveAttribute('href', `/api/auth/login?next=${encodeURIComponent('/members/222?tab=x')}`);
    expect(screen.queryByText(/hello/)).toBeNull();
  });

  it('shows "Login is unavailable right now" on 503, without a sign-in link', async () => {
    mockFetch({ 'GET /api/me': { status: 503, body: { error: 'unavailable', message: 'browser login not configured' } } });
    renderWithProviders(
      <AuthGate>
        <Secret />
      </AuthGate>,
    );
    expect(await screen.findByText(/Login is unavailable right now/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with Discord' })).toBeNull();
  });

  it('renders the app for a signed-in user (cookie sent same-origin)', async () => {
    const { calls } = mockFetch({ 'GET /api/me': { body: ME } });
    renderWithProviders(
      <AuthGate>
        <Secret />
      </AuthGate>,
    );
    expect(await screen.findByText('hello pilot')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: '/api/me', credentials: 'same-origin' });
  });

  it('explains a failed login and drops login_error from the next path', async () => {
    mockFetch({ 'GET /api/me': { status: 401, body: { error: 'unauthenticated', message: 'x' } } });
    renderWithProviders(
      <AuthGate>
        <Secret />
      </AuthGate>,
      { route: '/?login_error=denied' },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Discord sign-in was cancelled.');
    expect(screen.getByRole('link', { name: 'Sign in with Discord' })).toHaveAttribute(
      'href',
      `/api/auth/login?next=${encodeURIComponent('/')}`,
    );
  });

  it.each([
    ['not_member', "Only members of the org's Discord server can use the hangar editor."],
    ['discord_unavailable', 'Discord is unavailable — try again shortly.'],
    ['brand_new_code', 'Sign-in failed (brand_new_code). Please try again.'],
  ])('explains login_error=%s', async (code, text) => {
    mockFetch({ 'GET /api/me': { status: 401, body: { error: 'unauthenticated', message: 'x' } } });
    renderWithProviders(
      <AuthGate>
        <Secret />
      </AuthGate>,
      { route: `/?login_error=${code}` },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('offers a retry for other errors', async () => {
    mockFetch({ 'GET /api/me': { status: 500, body: { error: 'unavailable', message: 'boom' } } });
    renderWithProviders(
      <AuthGate>
        <Secret />
      </AuthGate>,
    );
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('falls back to sign-in when a later API call returns 401 (expired session)', async () => {
    let meStatus = 200;
    mockFetch({
      'GET /api/me': () =>
        meStatus === 200 ? { body: ME } : { status: 401, body: { error: 'unauthenticated', message: 'expired' } },
      'GET /api/v1/members/111/hangar': () => {
        meStatus = 401;
        return { status: 401, body: { error: 'unauthenticated', message: 'expired' } };
      },
    });
    renderWithProviders(<App />);
    expect(await screen.findByRole('link', { name: 'Sign in with Discord' })).toBeInTheDocument();
  });

  it('signs out via POST /api/auth/logout and returns to the sign-in page', async () => {
    let signedIn = true;
    const { calls } = mockFetch({
      'GET /api/me': () =>
        signedIn ? { body: ME } : { status: 401, body: { error: 'unauthenticated', message: 'no session' } },
      'GET /api/v1/members/111/hangar': { body: { member: '111', ships: [] } },
      'POST /api/auth/logout': () => {
        signedIn = false;
        return { status: 204 };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign in with Discord' })).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/auth/logout')).toBe(true);
  });

  it('reports a failed sign-out and stays signed in (no unhandled rejection)', async () => {
    mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': { body: { member: '111', ships: [] } },
      'POST /api/auth/logout': { status: 403, body: { error: 'forbidden', message: 'cross-origin write refused' } },
    });
    const user = userEvent.setup();
    renderWithProviders(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out failed: Not allowed: cross-origin write refused');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with Discord' })).toBeNull();
  });

  it('says the Discord profile and server membership are used to sign in', async () => {
    mockFetch({ 'GET /api/me': { status: 401, body: { error: 'unauthenticated', message: 'x' } } });
    renderWithProviders(
      <AuthGate>
        <Secret />
      </AuthGate>,
    );
    expect(
      await screen.findByText(
        "Your Discord profile and your membership in the org's Discord server are used to sign you in.",
      ),
    ).toBeInTheDocument();
  });
});
