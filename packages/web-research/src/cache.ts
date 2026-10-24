/**
 * In-memory cache with configurable TTL.
 * Supports different TTLs per entry and exposes stats for the status resource.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  createdAt: number;
}

export interface CacheStats {
  totalEntries: number;
  searchEntries: number;
  pageEntries: number;
  oldestEntryAge: number | null;
}

export class WebResearchCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private searchTtlMs: number;
  private pageTtlMs: number;

  constructor(searchTtlSeconds: number = 900, pageTtlSeconds: number = 3600) {
    this.searchTtlMs = searchTtlSeconds * 1000;
    this.pageTtlMs = pageTtlSeconds * 1000;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  async setSearch<T>(key: string, data: T): Promise<void> {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.searchTtlMs,
      createdAt: Date.now(),
    });
  }

  async setPage<T>(key: string, data: T): Promise<void> {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.pageTtlMs,
      createdAt: Date.now(),
    });
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  getStats(): CacheStats {
    // Prune expired entries first
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }

    let searchEntries = 0;
    let pageEntries = 0;
    let oldestCreated: number | null = null;

    for (const [key, entry] of this.cache) {
      if (key.startsWith('search:')) {
        searchEntries++;
      } else if (key.startsWith('page:')) {
        pageEntries++;
      }
      if (oldestCreated === null || entry.createdAt < oldestCreated) {
        oldestCreated = entry.createdAt;
      }
    }

    return {
      totalEntries: this.cache.size,
      searchEntries,
      pageEntries,
      oldestEntryAge: oldestCreated !== null ? Math.round((now - oldestCreated) / 1000) : null,
    };
  }

  getCachedSearchQueries(): string[] {
    const now = Date.now();
    const queries: string[] = [];
    for (const [key, entry] of this.cache) {
      if (key.startsWith('search:') && now <= entry.expiresAt) {
        queries.push(key.replace('search:', ''));
      }
    }
    return queries;
  }
}
