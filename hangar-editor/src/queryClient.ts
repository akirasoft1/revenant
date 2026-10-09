import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, isUnauthenticated } from './api/client';

export const ME_KEY = ['me'] as const;

/**
 * Any 401 anywhere (expired / rotated session cookie) re-checks `/api/me`,
 * which then 401s too and the AuthGate swaps the page for "Sign in with Discord".
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => {
        if (isUnauthenticated(err) && query.queryKey[0] !== ME_KEY[0]) {
          void client.invalidateQueries({ queryKey: ME_KEY });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (err) => {
        if (isUnauthenticated(err)) void client.invalidateQueries({ queryKey: ME_KEY });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Never retry a client error (401/403/404/...); retry 5xx/network twice.
        retry: (count, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) && count < 2,
      },
      mutations: { retry: false },
    },
  });
  return client;
}
