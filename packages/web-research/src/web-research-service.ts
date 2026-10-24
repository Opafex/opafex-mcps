/**
 * WebResearchService — standalone web research with search, fetch, and synthesis.
 * No LLM access — synthesis is structured extraction, not generation.
 *
 * Every page fetch goes through `fetchValidated`: the URL is SSRF-checked,
 * fetched with `redirect: 'manual'`, and every redirect hop is checked again
 * before it is followed. Letting `fetch` follow redirects itself would check
 * only the first URL — a public page that 302s to 169.254.169.254 would sail
 * through.
 *
 * IMPORTANT: No ES2018+ regex flags (no `s` flag). Uses [\s\S] instead.
 */

import { extractRawText, extractTitle, extractLinks } from './html-parser.js';
import { validateExternalURL } from './url-validator.js';
import type { LookupFn } from './url-validator.js';
import { WebResearchCache } from './cache.js';
import type { CacheStats } from './cache.js';
import { NonRetryableSearchError, selectSearchProvider } from './search-providers.js';
import type { SearchResult, SearchProviderSelection } from './search-providers.js';
import { DEFAULT_USER_AGENT } from './version.js';

export type { SearchResult } from './search-providers.js';

// ============================================================================
// TYPES
// ============================================================================

export interface FetchResult {
  title: string;
  text: string;
  links?: Array<{ text: string; href: string }>;
  url: string;
  /** Present when the page was reached through one or more redirects. */
  finalUrl?: string;
  fetchedAt: string;
}

export interface ResearchSource {
  title: string;
  url: string;
  keyPoints: string[];
}

export interface ResearchResult {
  summary: string;
  sources: ResearchSource[];
  searchQuery: string;
  depth: string;
}

export interface ExtractedData {
  url: string;
  extracted: Record<string, string>;
  rawTextLength: number;
}

export interface PageInfo {
  url: string;
  title: string;
  textLength: number;
  snippet: string;
}

export interface CompareResult {
  pages: PageInfo[];
  comparison: string;
}

export interface WebResearchConfig {
  searchCacheTtl?: number; // seconds, default 900 (15 min)
  pageCacheTtl?: number;   // seconds, default 3600 (1 hour)
  fetchTimeoutMs?: number; // per request, across all redirect hops; default 10000
  maxHtmlSize?: number;    // bytes read from a page body, default 1_000_000
  maxRedirects?: number;   // default 5
  userAgent?: string;      // default DEFAULT_USER_AGENT
  /** Search provider. Defaults to `selectSearchProvider(process.env)`. */
  search?: SearchProviderSelection;
  /** DNS lookup used by the SSRF check. Defaults to `dns.promises.lookup`. Injectable for tests. */
  lookup?: LookupFn;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_MAX_HTML_SIZE = 1_000_000; // 1MB
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RETRIES = 1;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Read at most `maxBytes` of a response body as UTF-8, then stop downloading.
 * `response.text()` would buffer the whole body, however large, before we
 * could truncate it.
 */
async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Stop the download if we quit early; a no-op if the stream is done
    await reader.cancel().catch(() => undefined);
  }

  const bytes = Buffer.concat(chunks).subarray(0, maxBytes);
  // A multi-byte character cut at the limit decodes to U+FFFD, not an error
  return new TextDecoder('utf-8').decode(bytes);
}

// ============================================================================
// SERVICE
// ============================================================================

export class WebResearchService {
  private cache: WebResearchCache;
  private fetchTimeoutMs: number;
  private maxHtmlSize: number;
  private maxRedirects: number;
  private userAgent: string;
  private search: SearchProviderSelection;
  private lookup?: LookupFn;

  constructor(config: WebResearchConfig = {}) {
    this.cache = new WebResearchCache(
      config.searchCacheTtl ?? 900,
      config.pageCacheTtl ?? 3600
    );
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxHtmlSize = config.maxHtmlSize ?? DEFAULT_MAX_HTML_SIZE;
    this.maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
    this.search = config.search ?? selectSearchProvider(process.env);
    this.lookup = config.lookup;
  }

  // --------------------------------------------------------------------------
  // web_search
  // --------------------------------------------------------------------------

  async webSearch(query: string, maxResults: number = 10, domain?: string): Promise<SearchResult[]> {
    if (!query || !query.trim()) {
      throw new Error('Search query is required');
    }

    // No provider configured — say so, naming the env var
    if (this.search.status === 'unavailable') {
      throw new Error(this.search.reason);
    }
    const provider = this.search.provider;

    const clampedMax = Math.min(Math.max(maxResults, 1), 20);
    const fullQuery = domain ? `${query} site:${domain}` : query;

    // Check cache
    const cacheKey = `search:${fullQuery}:${clampedMax}`;
    const cached = await this.cache.get<SearchResult[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // Fetch with retry
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
      try {
        let results = await provider.search(fullQuery, clampedMax, {
          userAgent: this.userAgent,
          signal: controller.signal,
        });

        // Apply domain filter on URLs (belt-and-suspenders with site: operator)
        if (domain) {
          const domainLower = domain.toLowerCase();
          results = results.filter((r) => {
            try {
              const hostname = new URL(r.url).hostname.toLowerCase();
              return hostname === domainLower || hostname.endsWith(`.${domainLower}`);
            } catch {
              return false;
            }
          });
        }

        // SSRF validation on result URLs
        results = await this.filterSafeResults(results);

        // Trim and re-index
        results = results.slice(0, clampedMax);

        // Cache results
        await this.cache.setSearch(cacheKey, results);

        return results;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof NonRetryableSearchError) break;
        if (attempt < MAX_RETRIES) continue;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error('Web search failed');
  }

  // --------------------------------------------------------------------------
  // fetch_webpage
  // --------------------------------------------------------------------------

  async fetchWebpage(
    url: string,
    extractMode: 'text' | 'links' | 'all' = 'text',
    maxLength: number = 4000
  ): Promise<FetchResult> {
    if (!url) {
      throw new Error('URL is required');
    }

    // SSRF protection (checked again on every hop inside fetchValidated)
    await validateExternalURL(url, { lookup: this.lookup });

    // Check page cache
    const cacheKey = `page:${url}:${extractMode}:${maxLength}`;
    const cached = await this.cache.get<FetchResult>(cacheKey);
    if (cached) {
      return cached;
    }

    // Fetch with timeout and size limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const { response, finalUrl } = await this.fetchValidated(url, controller.signal);

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Content type check
      const contentType = response.headers.get('content-type') || '';
      if (
        !contentType.includes('text/') &&
        !contentType.includes('application/xhtml') &&
        !contentType.includes('application/json')
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Unsupported content type: ${contentType}`);
      }

      const truncatedHtml = await readTextLimited(response, this.maxHtmlSize);

      // Extract title
      const title = extractTitle(truncatedHtml);

      // Extract text
      let text = extractRawText(truncatedHtml, ['nav', 'footer']);

      // Truncate text
      if (text.length > maxLength) {
        text = text.slice(0, maxLength) + '\n\n[... content truncated]';
      }

      // Extract links if requested
      let links: Array<{ text: string; href: string }> | undefined;
      if (extractMode === 'links' || extractMode === 'all') {
        links = extractLinks(truncatedHtml);
      }

      const result: FetchResult = {
        title,
        text: extractMode === 'links' ? '' : text,
        links,
        url,
        ...(finalUrl !== url ? { finalUrl } : {}),
        fetchedAt: new Date().toISOString(),
      };

      // Cache the result
      await this.cache.setPage(cacheKey, result);

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch webpage';
      if (controller.signal.aborted || message.includes('aborted')) {
        throw new Error(`Request timed out (${this.fetchTimeoutMs / 1000}s limit)`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --------------------------------------------------------------------------
  // research_topic
  // --------------------------------------------------------------------------

  async researchTopic(
    topic: string,
    depth: 'quick' | 'standard' | 'deep' = 'standard',
    maxSources: number = 5
  ): Promise<ResearchResult> {
    if (!topic || !topic.trim()) {
      throw new Error('Topic is required');
    }

    const clampedSources = Math.min(Math.max(maxSources, 1), 10);
    const searchCount = depth === 'quick' ? 3 : depth === 'deep' ? 10 : 5;
    const textLength = depth === 'quick' ? 2000 : depth === 'deep' ? 8000 : 4000;

    // Stage 1: Search
    const searchResults = await this.webSearch(topic, searchCount);

    // Stage 2: Fetch top N results
    const sources: ResearchSource[] = [];
    const fetchLimit = Math.min(clampedSources, searchResults.length);

    const fetchPromises = searchResults.slice(0, fetchLimit).map(async (sr) => {
      try {
        const page = await this.fetchWebpage(sr.url, 'text', textLength);
        return { searchResult: sr, page };
      } catch {
        // If fetch fails, use the snippet from search
        return { searchResult: sr, page: null };
      }
    });

    const fetchResults = await Promise.allSettled(fetchPromises);

    for (const settled of fetchResults) {
      if (settled.status === 'fulfilled') {
        const { searchResult, page } = settled.value;
        const keyPoints = page
          ? this.extractKeyPoints(page.text, topic)
          : [searchResult.snippet];

        sources.push({
          title: page?.title || searchResult.title,
          url: searchResult.url,
          keyPoints,
        });
      }
    }

    // Stage 3: Compile structured summary (no LLM — just organized extraction)
    const summary = this.compileSummary(topic, sources);

    return {
      summary,
      sources,
      searchQuery: topic,
      depth,
    };
  }

  // --------------------------------------------------------------------------
  // extract_structured_data
  // --------------------------------------------------------------------------

  async extractStructuredData(
    url: string,
    fields: string[]
  ): Promise<ExtractedData> {
    if (!url) {
      throw new Error('URL is required');
    }
    if (!fields || fields.length === 0) {
      throw new Error('At least one field is required');
    }

    const page = await this.fetchWebpage(url, 'text', 50000);
    const text = page.text;
    const extracted: Record<string, string> = {};

    for (const field of fields) {
      extracted[field] = this.extractFieldFromText(text, field);
    }

    return {
      url,
      extracted,
      rawTextLength: text.length,
    };
  }

  // --------------------------------------------------------------------------
  // compare_pages
  // --------------------------------------------------------------------------

  async comparePages(
    urls: string[],
    focus?: string
  ): Promise<CompareResult> {
    if (!urls || urls.length < 2) {
      throw new Error('At least 2 URLs are required');
    }
    if (urls.length > 5) {
      throw new Error('Maximum 5 URLs allowed');
    }

    const pages: PageInfo[] = [];
    const fullTexts: Array<{ url: string; text: string }> = [];

    const fetchPromises = urls.map(async (url) => {
      try {
        const page = await this.fetchWebpage(url, 'text', 8000);
        return { url, page };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Fetch failed';
        return { url, error: message };
      }
    });

    const results = await Promise.allSettled(fetchPromises);

    for (const settled of results) {
      if (settled.status === 'fulfilled') {
        const result = settled.value;
        if ('page' in result && result.page) {
          pages.push({
            url: result.url,
            title: result.page.title,
            textLength: result.page.text.length,
            snippet: result.page.text.slice(0, 300),
          });
          fullTexts.push({ url: result.url, text: result.page.text });
        } else if ('error' in result) {
          pages.push({
            url: result.url,
            title: '(fetch failed)',
            textLength: 0,
            snippet: `Error: ${result.error}`,
          });
        }
      }
    }

    // Build comparison summary
    const comparison = this.buildComparison(pages, fullTexts, focus);

    return { pages, comparison };
  }

  // --------------------------------------------------------------------------
  // Resource handlers
  // --------------------------------------------------------------------------

  getStatus(): { cacheStats: CacheStats; config: Record<string, unknown> } {
    return {
      cacheStats: this.cache.getStats(),
      config: {
        searchProvider: this.search.status === 'ok' ? this.search.provider.name : null,
        ...(this.search.status === 'unavailable' ? { searchUnavailable: this.search.reason } : {}),
        fetchTimeoutMs: this.fetchTimeoutMs,
        maxHtmlSize: this.maxHtmlSize,
        maxRedirects: this.maxRedirects,
        userAgent: this.userAgent,
      },
    };
  }

  getCachedQueries(): { queries: string[] } {
    return {
      queries: this.cache.getCachedSearchQueries(),
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Fetch a URL, following redirects by hand so that EVERY hop passes the
   * SSRF check — not just the URL the caller asked for. Returns the first
   * non-redirect response (its body unread) and the URL it came from.
   */
  private async fetchValidated(
    url: string,
    signal: AbortSignal
  ): Promise<{ response: Response; finalUrl: string }> {
    let current = url;

    for (let hop = 0; ; hop++) {
      await validateExternalURL(current, { lookup: this.lookup });

      const response = await fetch(current, {
        signal,
        redirect: 'manual',
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html, application/xhtml+xml, text/plain',
        },
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, finalUrl: current };
      }

      // A redirect — discard its body and work out where it points
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`HTTP ${response.status} redirect from ${current} has no Location header`);
      }
      if (hop >= this.maxRedirects) {
        throw new Error(`Too many redirects (more than ${this.maxRedirects}) fetching ${url}`);
      }

      try {
        current = new URL(location, current).toString();
      } catch {
        throw new Error(`Invalid redirect Location from ${current}: ${location}`);
      }
    }
  }

  /**
   * Filter out search results with URLs that fail SSRF validation.
   */
  private async filterSafeResults(results: SearchResult[]): Promise<SearchResult[]> {
    const checks = await Promise.all(
      results.map(async (result) => {
        try {
          await validateExternalURL(result.url, { lookup: this.lookup });
          return true;
        } catch {
          // Skip unsafe URLs
          return false;
        }
      })
    );
    return results.filter((_, i) => checks[i]);
  }

  /**
   * Extract key points (sentences) from page text relevant to a topic.
   * Simple heuristic: split into sentences, score by keyword overlap.
   */
  private extractKeyPoints(text: string, topic: string): string[] {
    if (!text) return [];

    // Split topic into keywords
    const keywords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

    // Split text into sentences
    const sentences = text
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 500);

    // Score sentences by keyword overlap
    const scored = sentences.map((sentence) => {
      const lower = sentence.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score++;
      }
      return { sentence, score };
    });

    // Sort by score descending, take top 5
    scored.sort((a, b) => b.score - a.score);
    const topSentences = scored
      .filter((s) => s.score > 0)
      .slice(0, 5)
      .map((s) => s.sentence);

    // If no keyword matches, take first 3 sentences
    if (topSentences.length === 0) {
      return sentences.slice(0, 3);
    }

    return topSentences;
  }

  /**
   * Compile a structured summary from sources (no LLM).
   */
  private compileSummary(topic: string, sources: ResearchSource[]): string {
    if (sources.length === 0) {
      return `No results found for "${topic}".`;
    }

    const parts: string[] = [];
    parts.push(`Research findings for "${topic}" from ${sources.length} source(s):\n`);

    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      parts.push(`[${i + 1}] ${src.title} (${src.url})`);
      if (src.keyPoints.length > 0) {
        for (const point of src.keyPoints) {
          parts.push(`  - ${point}`);
        }
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Extract a field value from page text using heuristic section matching.
   * Looks for headings/labels that match the field name and extracts nearby text.
   */
  private extractFieldFromText(text: string, field: string): string {
    const fieldLower = field.toLowerCase();
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    // Look for a line that contains the field name (case-insensitive)
    let startIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(fieldLower)) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) {
      return `No "${field}" section found on page.`;
    }

    // Grab the matching line and up to 10 subsequent lines as context
    const contextLines = lines.slice(startIndex, startIndex + 11);
    return contextLines.join(' ').slice(0, 1000);
  }

  /**
   * Build a text comparison of multiple pages.
   */
  private buildComparison(
    pages: PageInfo[],
    fullTexts: Array<{ url: string; text: string }>,
    focus?: string
  ): string {
    const parts: string[] = [];
    parts.push(`Comparison of ${pages.length} page(s)${focus ? ` focusing on "${focus}"` : ''}:\n`);

    for (const page of pages) {
      parts.push(`- ${page.title} (${page.url}): ${page.textLength} chars`);
    }

    if (focus && fullTexts.length > 0) {
      parts.push(`\nFocus area "${focus}":`);
      for (const ft of fullTexts) {
        const fieldValue = this.extractFieldFromText(ft.text, focus);
        parts.push(`\n[${ft.url}]`);
        parts.push(fieldValue);
      }
    }

    return parts.join('\n');
  }
}
