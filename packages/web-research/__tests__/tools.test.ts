import { describe, it, expect, vi, afterEach } from 'vitest';
import { webResearchTools } from '../src/tools.js';
import { WebResearchService } from '../src/web-research-service.js';
import { selectSearchProvider, BRAVE_SEARCH_URL } from '../src/search-providers.js';
import { fakeLookup, installFetch, htmlResponse, jsonResponse, html } from './helpers.js';

const lookup = fakeLookup({
  'example.com': ['93.184.216.34'],
  'a.example': ['93.184.216.40'],
  'b.example': ['93.184.216.41'],
  'c.example': ['93.184.216.42'],
});

function makeTools(env: Record<string, string> = { BRAVE_SEARCH_API_KEY: 'k' }, extra = {}) {
  const service = new WebResearchService({ lookup, search: selectSearchProvider(env), ...extra });
  const tools = webResearchTools(service);
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool "${name}" not found`);
    return tool.handler(args, {});
  };
  return { service, tools, call };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const PRICING_PAGE = html(`
  <nav>Home Pricing Blog</nav>
  <h1>Acme Widgets</h1>
  <p>Acme widgets are the best widgets for research teams.</p>
  <h2>Features</h2>
  <p>Fast search. Clean output.</p>
  <h2>Plans</h2>
  <p>Pricing starts at 10 GBP per month.</p>
  <a href="https://example.com/signup">Sign up</a>
  <footer>Copyright Acme</footer>`, 'Acme');

describe('webResearchTools', () => {
  it('defines the five tools with schemas', () => {
    const { tools } = makeTools();
    expect(tools.map((t) => t.name)).toEqual([
      'web_search',
      'fetch_webpage',
      'research_topic',
      'extract_structured_data',
      'compare_pages',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('web_search', () => {
  it('returns provider results', async () => {
    installFetch({
      [`${BRAVE_SEARCH_URL}?q=widgets&count=3`]: () =>
        jsonResponse({ web: { results: [{ title: 'Acme', url: 'https://example.com/', description: 'Widgets' }] } }),
    });
    const { call } = makeTools();
    expect(await call('web_search', { query: 'widgets', maxResults: 3 })).toEqual([
      { title: 'Acme', url: 'https://example.com/', snippet: 'Widgets' },
    ]);
  });

  it('adds site: and filters to the domain', async () => {
    installFetch({
      [`${BRAVE_SEARCH_URL}?q=widgets+site%3Aexample.com&count=10`]: () =>
        jsonResponse({
          web: {
            results: [
              { title: 'In', url: 'https://example.com/a' },
              { title: 'Off-domain', url: 'https://a.example/' },
            ],
          },
        }),
    });
    const { call } = makeTools();
    const results = (await call('web_search', { query: 'widgets', domain: 'example.com' })) as Array<{ title: string }>;
    expect(results.map((r) => r.title)).toEqual(['In']);
  });

  it('caches results', async () => {
    const { fetch } = installFetch({
      [`${BRAVE_SEARCH_URL}?q=cached&count=10`]: () => jsonResponse({ web: { results: [] } }),
    });
    const { call } = makeTools();
    await call('web_search', { query: 'cached' });
    await call('web_search', { query: 'cached' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty query', async () => {
    const { call } = makeTools();
    await expect(call('web_search', { query: '  ' })).rejects.toThrow('Search query is required');
  });

  it('errors with the env var name when no provider is configured', async () => {
    const { call } = makeTools({});
    await expect(call('web_search', { query: 'x' })).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
  });
});

describe('fetch_webpage', () => {
  it('returns title and clean text without nav/footer', async () => {
    installFetch({ 'https://example.com/': () => htmlResponse(PRICING_PAGE) });
    const { call } = makeTools();
    const result = (await call('fetch_webpage', { url: 'https://example.com/' })) as Record<string, unknown>;
    expect(result.title).toBe('Acme');
    expect(result.text).toContain('Pricing starts at 10 GBP');
    expect(result.text).not.toContain('Copyright Acme');
    expect(result.text).not.toContain('Home Pricing Blog');
    expect(result.links).toBeUndefined();
    expect(result.url).toBe('https://example.com/');
    expect(result.fetchedAt).toBeDefined();
  });

  it('sends the honest default user agent', async () => {
    const { calls } = installFetch({ 'https://example.com/': () => htmlResponse(PRICING_PAGE) });
    const { call } = makeTools();
    await call('fetch_webpage', { url: 'https://example.com/' });
    const ua = (calls[0].init?.headers as Record<string, string>)['User-Agent'];
    expect(ua).toMatch(/^opafex-mcp-web-research\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Opafex\/opafex-mcps\)$/);
  });

  it('uses an overridden user agent', async () => {
    const { calls } = installFetch({ 'https://example.com/': () => htmlResponse(PRICING_PAGE) });
    const { call } = makeTools(undefined, { userAgent: 'my-bot/2.0' });
    await call('fetch_webpage', { url: 'https://example.com/' });
    expect((calls[0].init?.headers as Record<string, string>)['User-Agent']).toBe('my-bot/2.0');
  });

  it('extracts links only in links mode', async () => {
    installFetch({ 'https://example.com/': () => htmlResponse(PRICING_PAGE) });
    const { call } = makeTools();
    const result = (await call('fetch_webpage', { url: 'https://example.com/', extractMode: 'links' })) as Record<string, unknown>;
    expect(result.text).toBe('');
    expect(result.links).toEqual([{ text: 'Sign up', href: 'https://example.com/signup' }]);
  });

  it('truncates text to maxLength', async () => {
    installFetch({ 'https://example.com/': () => htmlResponse(html(`<p>${'word '.repeat(500)}</p>`)) });
    const { call } = makeTools();
    const result = (await call('fetch_webpage', { url: 'https://example.com/', maxLength: 50 })) as { text: string };
    // The page title is part of the extracted text, then the body
    expect(result.text).toContain('word word');
    expect(result.text).toContain('[... content truncated]');
    expect(result.text.length).toBeLessThan(100);
  });

  it('reads no more than maxHtmlSize bytes of the body', async () => {
    const big = html(`<p>${'a'.repeat(5000)}</p><p>TAIL-MARKER</p>`);
    installFetch({ 'https://example.com/': () => htmlResponse(big) });
    const { call } = makeTools(undefined, { maxHtmlSize: 1000 });
    const result = (await call('fetch_webpage', { url: 'https://example.com/', maxLength: 100000 })) as { text: string };
    expect(result.text).not.toContain('TAIL-MARKER');
    expect(result.text.length).toBeLessThanOrEqual(1000);
  });

  it('caches pages', async () => {
    const { fetch } = installFetch({ 'https://example.com/': () => htmlResponse(PRICING_PAGE) });
    const { call } = makeTools();
    await call('fetch_webpage', { url: 'https://example.com/' });
    await call('fetch_webpage', { url: 'https://example.com/' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a private URL without fetching it', async () => {
    const { fetch } = installFetch({});
    const { call } = makeTools();
    await expect(call('fetch_webpage', { url: 'http://192.168.0.1/' })).rejects.toThrow(/not allowed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports HTTP errors', async () => {
    installFetch({ 'https://example.com/missing': () => htmlResponse('nope', 404) });
    const { call } = makeTools();
    await expect(call('fetch_webpage', { url: 'https://example.com/missing' })).rejects.toThrow(/HTTP 404/);
  });

  it('refuses binary content types', async () => {
    installFetch({
      'https://example.com/file.zip': () =>
        new Response('PK', { status: 200, headers: { 'content-type': 'application/zip' } }),
    });
    const { call } = makeTools();
    await expect(call('fetch_webpage', { url: 'https://example.com/file.zip' })).rejects.toThrow(/Unsupported content type/);
  });

  it('times out a slow server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
          })
      )
    );
    const { call } = makeTools(undefined, { fetchTimeoutMs: 20 });
    await expect(call('fetch_webpage', { url: 'https://example.com/' })).rejects.toThrow(/timed out/);
  });

  it('works with no search provider configured', async () => {
    installFetch({ 'https://example.com/': () => htmlResponse(PRICING_PAGE) });
    const { call } = makeTools({});
    const result = (await call('fetch_webpage', { url: 'https://example.com/' })) as { title: string };
    expect(result.title).toBe('Acme');
  });
});

describe('research_topic', () => {
  it('searches, fetches the top sources and compiles a summary', async () => {
    installFetch({
      [`${BRAVE_SEARCH_URL}?q=acme+widgets&count=5`]: () =>
        jsonResponse({
          web: {
            results: [
              { title: 'A', url: 'https://a.example/', description: 'snippet A' },
              { title: 'B', url: 'https://b.example/', description: 'snippet B' },
            ],
          },
        }),
      'https://a.example/': () =>
        htmlResponse(html('<p>Acme widgets are made in Sheffield by a small team.</p><p>Unrelated sentence about the weather today.</p>', 'Page A')),
      // b.example fails, so its search snippet is used instead
      'https://b.example/': () => htmlResponse('gone', 500),
    });
    const { call } = makeTools();
    const result = (await call('research_topic', { topic: 'acme widgets' })) as {
      summary: string;
      sources: Array<{ title: string; url: string; keyPoints: string[] }>;
      depth: string;
    };

    expect(result.depth).toBe('standard');
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].title).toBe('Page A');
    expect(result.sources[0].url).toBe('https://a.example/');
    // Only the sentence that mentions the topic is a key point
    expect(result.sources[0].keyPoints).toHaveLength(1);
    expect(result.sources[0].keyPoints[0]).toContain('Acme widgets are made in Sheffield by a small team');
    expect(result.sources[1]).toEqual({ title: 'B', url: 'https://b.example/', keyPoints: ['snippet B'] });
    expect(result.summary).toContain('from 2 source(s)');
    expect(result.summary).toContain('[1] Page A (https://a.example/)');
  });

  it('errors with the env var name when no provider is configured', async () => {
    const { call } = makeTools({});
    await expect(call('research_topic', { topic: 'x' })).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
  });
});

describe('extract_structured_data', () => {
  it('pulls the section around each requested field', async () => {
    installFetch({ 'https://example.com/': () => htmlResponse(PRICING_PAGE) });
    const { call } = makeTools({});
    const result = (await call('extract_structured_data', {
      url: 'https://example.com/',
      fields: ['pricing', 'features', 'warranty'],
    })) as { extracted: Record<string, string>; rawTextLength: number };

    expect(result.extracted.pricing).toContain('10 GBP per month');
    expect(result.extracted.features).toContain('Fast search');
    expect(result.extracted.warranty).toBe('No "warranty" section found on page.');
    expect(result.rawTextLength).toBeGreaterThan(0);
  });

  it('requires at least one field', async () => {
    const { call } = makeTools({});
    await expect(call('extract_structured_data', { url: 'https://example.com/', fields: [] })).rejects.toThrow(
      'At least one field is required'
    );
  });
});

describe('compare_pages', () => {
  it('compares pages and reports failures per page', async () => {
    installFetch({
      'https://a.example/': () => htmlResponse(html('<p>Pricing: 5 GBP</p>', 'A')),
      'https://b.example/': () => htmlResponse(html('<p>Pricing: 9 GBP</p>', 'B')),
    });
    const { call } = makeTools({});
    const result = (await call('compare_pages', {
      urls: ['https://a.example/', 'https://b.example/', 'http://127.0.0.1/'],
      focus: 'pricing',
    })) as { pages: Array<{ url: string; title: string; snippet: string }>; comparison: string };

    expect(result.pages.map((p) => p.title)).toEqual(['A', 'B', '(fetch failed)']);
    expect(result.pages[2].snippet).toMatch(/not allowed/);
    expect(result.comparison).toContain('focusing on "pricing"');
    expect(result.comparison).toContain('5 GBP');
    expect(result.comparison).toContain('9 GBP');
  });

  it('requires 2 to 5 URLs', async () => {
    const { call } = makeTools({});
    await expect(call('compare_pages', { urls: ['https://a.example/'] })).rejects.toThrow('At least 2 URLs');
    await expect(
      call('compare_pages', { urls: ['1', '2', '3', '4', '5', '6'].map((n) => `https://a.example/${n}`) })
    ).rejects.toThrow('Maximum 5 URLs');
  });
});
