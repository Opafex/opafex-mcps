import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebResearchCache } from '../src/cache.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('WebResearchCache', () => {
  it('returns null for a missing key', async () => {
    const cache = new WebResearchCache();
    expect(await cache.get('search:nothing')).toBeNull();
  });

  it('stores and returns search and page entries', async () => {
    const cache = new WebResearchCache();
    await cache.setSearch('search:q:10', [{ title: 't' }]);
    await cache.setPage('page:https://a/:text:4000', { title: 'A' });
    expect(await cache.get('search:q:10')).toEqual([{ title: 't' }]);
    expect(await cache.get('page:https://a/:text:4000')).toEqual({ title: 'A' });
  });

  it('expires search and page entries on their own TTLs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new WebResearchCache(10, 60);
    await cache.setSearch('search:q', 'S');
    await cache.setPage('page:p', 'P');

    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'));
    expect(await cache.get('search:q')).toBeNull();
    expect(await cache.get('page:p')).toBe('P');

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(await cache.get('page:p')).toBeNull();
  });

  it('reports stats and prunes expired entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new WebResearchCache(10, 60);
    await cache.setSearch('search:a', 1);
    await cache.setSearch('search:b', 2);
    await cache.setPage('page:c', 3);

    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    expect(cache.getStats()).toEqual({ totalEntries: 3, searchEntries: 2, pageEntries: 1, oldestEntryAge: 5 });

    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    expect(cache.getStats()).toEqual({ totalEntries: 1, searchEntries: 0, pageEntries: 1, oldestEntryAge: 30 });
  });

  it('reports null age when empty', () => {
    expect(new WebResearchCache().getStats().oldestEntryAge).toBeNull();
  });

  it('lists live cached search queries only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new WebResearchCache(10, 60);
    await cache.setSearch('search:old query:10', []);
    vi.setSystemTime(new Date('2026-01-01T00:00:08Z'));
    await cache.setSearch('search:new query:10', []);
    await cache.setPage('page:x', {});

    vi.setSystemTime(new Date('2026-01-01T00:00:12Z'));
    expect(cache.getCachedSearchQueries()).toEqual(['new query:10']);
  });

  it('clear() empties the cache', async () => {
    const cache = new WebResearchCache();
    await cache.setSearch('search:a', 1);
    await cache.clear();
    expect(cache.getStats().totalEntries).toBe(0);
  });
});
