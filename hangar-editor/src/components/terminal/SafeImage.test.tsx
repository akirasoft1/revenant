import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SafeImage } from './SafeImage';

function stubFetch() {
  const fn = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('SafeImage', () => {
  it('falls back to the icon and reports once on error', () => {
    const fn = stubFetch();
    render(<SafeImage src="https://cdn.star-citizen.wiki/a.png" alt="A" type="Shield" context="card" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByTestId('type-icon')).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/client-events/image-error');
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://cdn.star-citizen.wiki/a.png', context: 'card' });
  });
  it('two images with the same failing src report once', () => {
    const fn = stubFetch();
    render(
      <>
        <SafeImage src="https://cdn.star-citizen.wiki/dup.png" alt="1" type="Shield" context="card" />
        <SafeImage src="https://cdn.star-citizen.wiki/dup.png" alt="2" type="Shield" context="compare" />
      </>,
    );
    screen.getAllByRole('img').forEach((i) => fireEvent.error(i));
    expect(screen.getAllByTestId('type-icon')).toHaveLength(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('no src -> icon, no report', () => {
    const fn = stubFetch();
    render(<SafeImage alt="x" type="Cooler" context="card" />);
    expect(screen.getByTestId('type-icon')).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });
});
