/**
 * Search providers — where `web_search` and `research_topic` get results.
 *
 *   - Brave Search API (recommended): an official API with a free tier.
 *     Selected when BRAVE_SEARCH_API_KEY is set.
 *   - DuckDuckGo HTML scraper (opt-in only): parses html.duckduckgo.com.
 *     Not an API, can break whenever DuckDuckGo changes its markup, and
 *     automated querying is not permitted by DuckDuckGo's terms. Selected only
 *     by WEB_RESEARCH_SEARCH_PROVIDER=duckduckgo.
 *
 * With neither, search is UNAVAILABLE and says why; the fetch tools still work.
 *
 * IMPORTANT: No ES2018+ regex flags (no `s` flag). Uses [\s\S] instead.
 */

import { stripTags, decodeHtmlEntities } from './html-parser.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Per-request settings a provider needs to make its HTTP call. */
export interface SearchRequestContext {
  userAgent: string;
  signal: AbortSignal;
}

export interface SearchProvider {
  /** Short provider id, shown in the status resource. */
  readonly name: 'brave' | 'duckduckgo';
  search(query: string, count: number, ctx: SearchRequestContext): Promise<SearchResult[]>;
}

/**
 * A search failure that retrying will not fix (bad key, rate limit).
 * The service retries any other error once.
 */
export class NonRetryableSearchError extends Error {}

export type SearchProviderSelection =
  | { status: 'ok'; provider: SearchProvider }
  | { status: 'unavailable'; reason: string };

export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
export const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';

/** The error `web_search` / `research_topic` return when no provider is configured. */
export const SEARCH_NOT_CONFIGURED =
  'Web search is not configured. Set BRAVE_SEARCH_API_KEY (a Brave Search API key, https://brave.com/search/api/), ' +
  'or opt in to the unofficial DuckDuckGo HTML scraper with WEB_RESEARCH_SEARCH_PROVIDER=duckduckgo. ' +
  'fetch_webpage, extract_structured_data and compare_pages work without either.';

// ============================================================================
// SELECTION
// ============================================================================

/**
 * Pick the search provider from the environment.
 *
 *   WEB_RESEARCH_SEARCH_PROVIDER=duckduckgo → DuckDuckGo scraper (explicit opt-in)
 *   WEB_RESEARCH_SEARCH_PROVIDER=brave      → Brave; BRAVE_SEARCH_API_KEY required
 *   unset + BRAVE_SEARCH_API_KEY            → Brave
 *   unset, no key                           → unavailable
 *
 * Never throws: a misconfiguration makes search unavailable with a reason,
 * so the server still starts and the fetch tools still work.
 */
export function selectSearchProvider(env: Record<string, string | undefined>): SearchProviderSelection {
  const choice = (env.WEB_RESEARCH_SEARCH_PROVIDER || '').trim().toLowerCase();
  const braveKey = (env.BRAVE_SEARCH_API_KEY || '').trim();

  if (choice === 'duckduckgo') {
    return { status: 'ok', provider: new DuckDuckGoHtmlProvider() };
  }

  if (choice === 'brave' || choice === '') {
    if (braveKey) {
      return { status: 'ok', provider: new BraveSearchProvider(braveKey) };
    }
    if (choice === 'brave') {
      return {
        status: 'unavailable',
        reason: 'WEB_RESEARCH_SEARCH_PROVIDER=brave but BRAVE_SEARCH_API_KEY is not set. Get a key at https://brave.com/search/api/.',
      };
    }
    return { status: 'unavailable', reason: SEARCH_NOT_CONFIGURED };
  }

  return {
    status: 'unavailable',
    reason: `Unknown WEB_RESEARCH_SEARCH_PROVIDER "${env.WEB_RESEARCH_SEARCH_PROVIDER}". Use "brave" or "duckduckgo".`,
  };
}

// ============================================================================
// BRAVE SEARCH API
// ============================================================================

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave' as const;

  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number, ctx: SearchRequestContext): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      // Brave caps a page at 20 results
      count: String(Math.min(Math.max(count, 1), 20)),
    });

    const response = await fetch(`${BRAVE_SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': ctx.userAgent,
        'X-Subscription-Token': this.apiKey,
      },
      // A fixed API endpoint has no business redirecting us
      redirect: 'error',
      signal: ctx.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new NonRetryableSearchError(
        `Brave Search rejected the API key (HTTP ${response.status}). Check BRAVE_SEARCH_API_KEY.`
      );
    }
    if (response.status === 429) {
      throw new NonRetryableSearchError('Brave Search rate limit reached (HTTP 429). Try again later or upgrade the plan.');
    }
    if (!response.ok) {
      throw new Error(`Brave Search returned ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as BraveResponse;
    const results: SearchResult[] = [];

    for (const item of body.web?.results ?? []) {
      if (!item.url || !item.title) continue;
      results.push({
        // Brave marks matched terms with <strong>; strip to plain text
        title: decodeHtmlEntities(stripTags(item.title)).trim(),
        url: item.url,
        snippet: decodeHtmlEntities(stripTags(item.description || '')).trim(),
      });
    }

    return results;
  }
}

// ============================================================================
// DUCKDUCKGO HTML SCRAPER (opt-in)
// ============================================================================

export class DuckDuckGoHtmlProvider implements SearchProvider {
  readonly name = 'duckduckgo' as const;

  async search(query: string, _count: number, ctx: SearchRequestContext): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    const url = `${DDG_HTML_URL}?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': ctx.userAgent,
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'error',
      signal: ctx.signal,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned ${response.status} ${response.statusText}`);
    }

    return parseDuckDuckGoHtml(await response.text());
  }
}

/**
 * Parse the result blocks out of an html.duckduckgo.com results page.
 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Match each result block
  const resultBlockRegex =
    /<div[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*\bresult\b|<div[^>]*class=["'][^"']*\bno-results\b|$)/gi;

  const titleLinkRegex =
    /<a[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i;
  const titleLinkReversed =
    /<a[^>]*href=["']([^"']*)["'][^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i;
  const snippetRegex =
    /<a[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i;

  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = resultBlockRegex.exec(html)) !== null) {
    const block = blockMatch[0];

    const linkMatch = block.match(titleLinkRegex) || block.match(titleLinkReversed);
    if (!linkMatch) continue;

    const rawHref = linkMatch[1];
    const titleHtml = linkMatch[2];
    const title = decodeHtmlEntities(stripTags(titleHtml)).trim();
    const resultUrl = extractDuckDuckGoUrl(decodeHtmlEntities(rawHref));

    const snippetMatch = block.match(snippetRegex);
    const snippet = snippetMatch ? decodeHtmlEntities(stripTags(snippetMatch[1])).trim() : '';

    if (title && resultUrl) {
      results.push({ title, url: resultUrl, snippet });
    }
  }

  return results;
}

/**
 * Extract the real URL from a DuckDuckGo redirect href (`//duckduckgo.com/l/?uddg=...`).
 */
export function extractDuckDuckGoUrl(href: string): string | null {
  if (!href) return null;

  if (href.startsWith('http://') || href.startsWith('https://')) {
    return href;
  }

  if (href.includes('uddg=')) {
    try {
      const fullHref = href.startsWith('//') ? `https:${href}` : href;
      const parsed = new URL(fullHref, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) return uddg;
    } catch {
      // Fall through
    }
  }

  return null;
}
