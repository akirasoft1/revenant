import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { createQueryClient } from '../queryClient';
import type { Me } from '../api/types';

export const ME: Me = {
  discordId: '111',
  username: 'pilot',
  globalName: 'Pilot',
  avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
  isAdmin: false,
};

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

type Handler = (init: RequestInit & { url: string }) => { status?: number; body?: unknown } | undefined;

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  credentials?: RequestCredentials;
}

/**
 * Stub global fetch. `routes` keys are "METHOD /path-prefix" (query string
 * included in the match when present in the key); first match wins.
 */
export function mockFetch(routes: Record<string, Handler | { status?: number; body?: unknown }>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method, body, credentials: init.credentials });
    for (const [key, h] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      if (m !== method || !url.startsWith(p)) continue;
      const r = typeof h === 'function' ? h({ ...init, url }) : h;
      if (!r) continue;
      const status = r.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not_found', message: `unmocked ${method} ${url}` }), {
      status: 404,
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}
