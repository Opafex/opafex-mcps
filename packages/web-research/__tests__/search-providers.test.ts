import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  selectSearchProvider,
  BraveSearchProvider,
  DuckDuckGoHtmlProvider,
  parseDuckDuckGoHtml,
  extractDuckDuckGoUrl,
  BRAVE_SEARCH_URL,
  SEARCH_NOT_CONFIGURED,
} from '../src/search-providers.js';
import { WebResearchService } from '../src/web-research-service.js';
import { fakeLookup, installFetch, jsonResponse, htmlResponse } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = () => ({ userAgent: 'test-agent/1.0', signal: new AbortController().signal });

describe('selectSearchProvider', () => {
  it('uses Brave when BRAVE_SEARCH_API_KEY is set', () => {
    const sel = selectSearchProvider({ BRAVE_SEARCH_API_KEY: 'key' });
    expect(sel.status).toBe('ok');
    expect(sel.status === 'ok' && sel.provider.name).toBe('brave');
  });

  it('uses Brave when explicitly chosen with a key', () => {
    const sel = selectSearchProvider({ WEB_RESEARCH_SEARCH_PROVIDER: 'Brave', BRAVE_SEARCH_API_KEY: 'key' });
    expect(sel.status === 'ok' && sel.provider.name).toBe('brave');
  });

  it('uses DuckDuckGo only on explicit opt-in', () => {
    const sel = selectSearchProvider({ WEB_RESEARCH_SEARCH_PROVIDER: 'duckduckgo' });
    expect(sel.status === 'ok' && sel.provider.name).toBe('duckduckgo');
  });

  it('prefers the explicit DuckDuckGo opt-in even when a Brave key is set', () => {
    const sel = selectSearchProvider({ WEB_RESEARCH_SEARCH_PROVIDER: 'duckduckgo', BRAVE_SEARCH_API_KEY: 'key' });
    expect(sel.status === 'ok' && sel.provider.name).toBe('duckduckgo');
  });

  it('is unavailable with no key and no opt-in, naming the env var', () => {
    const sel = selectSearchProvider({});
    expect(sel).toEqual({ status: 'unavailable', reason: SEARCH_NOT_CONFIGURED });
    expect(SEARCH_NOT_CONFIGURED).toContain('BRAVE_SEARCH_API_KEY');
    expect(SEARCH_NOT_CONFIGURED).toContain('WEB_RESEARCH_SEARCH_PROVIDER=duckduckgo');
  });

  it('treats a blank key as no key', () => {
    expect(selectSearchProvider({ BRAVE_SEARCH_API_KEY: '   ' }).status).toBe('unavailable');
  });

  it('is unavailable when Brave is chosen without a key', () => {
    const sel = selectSearchProvider({ WEB_RESEARCH_SEARCH_PROVIDER: 'brave' });
    expect(sel.status).toBe('unavailable');
    expect(sel.status === 'unavailable' && sel.reason).toContain('BRAVE_SEARCH_API_KEY');
  });

  it('is unavailable for an unknown provider name, without throwing', () => {
    const sel = selectSearchProvider({ WEB_RESEARCH_SEARCH_PROVIDER: 'google', BRAVE_SEARCH_API_KEY: 'key' });
    expect(sel.status).toBe('unavailable');
    expect(sel.status === 'unavailable' && sel.reason).toContain('"google"');
  });
});

describe('BraveSearchProvider', () => {
  it('calls the Brave API with the key header and maps results', async () => {
    const { calls } = installFetch({
      [`${BRAVE_SEARCH_URL}?q=mcp+servers&count=5`]: () =>
        jsonResponse({
          web: {
            results: [
              { title: 'The <strong>MCP</strong> spec', url: 'https://modelcontextprotocol.io/', description: 'All about <strong>MCP</strong> &amp; servers' },
              { title: 'No URL' },
              { title: 'Second', url: 'https://example.com/2' },
            ],
          },
        }),
    });

    const results = await new BraveSearchProvider('secret-key').search('mcp servers', 5, ctx());
    expect(results).toEqual([
      { title: 'The MCP spec', url: 'https://modelcontextprotocol.io/', snippet: 'All about MCP & servers' },
      { title: 'Second', url: 'https://example.com/2', snippet: '' },
    ]);

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('secret-key');
    expect(headers['User-Agent']).toBe('test-agent/1.0');
    expect(calls[0].init?.redirect).toBe('error');
  });

  it('caps count at 20', async () => {
    const { calls } = installFetch({
      [`${BRAVE_SEARCH_URL}?q=x&count=20`]: () => jsonResponse({ web: { results: [] } }),
    });
    await new BraveSearchProvider('k').search('x', 50, ctx());
    expect(calls[0].url).toContain('count=20');
  });

  it('handles a response with no web section', async () => {
    installFetch({ [`${BRAVE_SEARCH_URL}?q=x&count=10`]: () => jsonResponse({}) });
    expect(await new BraveSearchProvider('k').search('x', 10, ctx())).toEqual([]);
  });

  it('names the env var when the key is rejected', async () => {
    installFetch({ [`${BRAVE_SEARCH_URL}?q=x&count=10`]: () => jsonResponse({}, 401) });
    await expect(new BraveSearchProvider('bad').search('x', 10, ctx())).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
  });
});

describe('DuckDuckGo HTML scraper', () => {
  const DDG_PAGE = `
    <div class="results">
      <div class="result results_links web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First &amp; best</a>
        <a class="result__snippet" href="#">Snippet <b>one</b></a>
      </div>
      <div class="result results_links web-result">
        <a href="https://example.org/two" class="result__a">Second</a>
      </div>
      <div class="result">
        <a class="result__a" href="/relative-junk">Dropped</a>
      </div>
      <div class="no-results"></div>
    </div>`;

  it('parses result blocks, unwrapping DuckDuckGo redirect links', () => {
    expect(parseDuckDuckGoHtml(DDG_PAGE)).toEqual([
      { title: 'First & best', url: 'https://example.com/one', snippet: 'Snippet one' },
      { title: 'Second', url: 'https://example.org/two', snippet: '' },
    ]);
  });

  it('extractDuckDuckGoUrl handles direct, wrapped and junk hrefs', () => {
    expect(extractDuckDuckGoUrl('https://a.example/')).toBe('https://a.example/');
    expect(extractDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2F')).toBe('https://b.example/');
    expect(extractDuckDuckGoUrl('/l/?uddg=https%3A%2F%2Fc.example%2F')).toBe('https://c.example/');
    expect(extractDuckDuckGoUrl('/nothing')).toBeNull();
    expect(extractDuckDuckGoUrl('')).toBeNull();
  });

  it('fetches html.duckduckgo.com with the configured user agent', async () => {
    const { calls } = installFetch({
      'https://html.duckduckgo.com/html/?q=test': () => htmlResponse(DDG_PAGE),
    });
    const results = await new DuckDuckGoHtmlProvider().search('test', 10, ctx());
    expect(results).toHaveLength(2);
    expect((calls[0].init?.headers as Record<string, string>)['User-Agent']).toBe('test-agent/1.0');
  });
});

describe('WebResearchService search behaviour', () => {
  const lookup = fakeLookup({ 'example.com': ['93.184.216.34'], 'internal.example': ['10.0.0.5'] });

  it('throws the unavailable reason without making any request', async () => {
    const { fetch } = installFetch({});
    const service = new WebResearchService({ lookup, search: { status: 'unavailable', reason: SEARCH_NOT_CONFIGURED } });
    await expect(service.webSearch('anything')).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
    await expect(service.researchTopic('anything')).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops search results whose URLs fail the SSRF check', async () => {
    installFetch({
      [`${BRAVE_SEARCH_URL}?q=q&count=10`]: () =>
        jsonResponse({
          web: {
            results: [
              { title: 'Public', url: 'https://example.com/' },
              { title: 'Loopback', url: 'http://127.0.0.1/' },
              { title: 'Internal', url: 'https://internal.example/' },
              { title: 'Unresolvable', url: 'https://nowhere.example/' },
            ],
          },
        }),
    });
    const service = new WebResearchService({ lookup, search: selectSearchProvider({ BRAVE_SEARCH_API_KEY: 'k' }) });
    const results = await service.webSearch('q');
    expect(results.map((r) => r.title)).toEqual(['Public']);
  });

  it('does not retry a rejected key', async () => {
    const { fetch } = installFetch({ [`${BRAVE_SEARCH_URL}?q=q&count=10`]: () => jsonResponse({}, 403) });
    const service = new WebResearchService({ lookup, search: selectSearchProvider({ BRAVE_SEARCH_API_KEY: 'k' }) });
    await expect(service.webSearch('q')).rejects.toThrow(/HTTP 403/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a server error once', async () => {
    const { fetch } = installFetch({ [`${BRAVE_SEARCH_URL}?q=q&count=10`]: () => jsonResponse({}, 500) });
    const service = new WebResearchService({ lookup, search: selectSearchProvider({ BRAVE_SEARCH_API_KEY: 'k' }) });
    await expect(service.webSearch('q')).rejects.toThrow(/500/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports the provider in the status resource, never the key', () => {
    const service = new WebResearchService({ lookup, search: selectSearchProvider({ BRAVE_SEARCH_API_KEY: 'super-secret' }) });
    const status = service.getStatus();
    expect(status.config.searchProvider).toBe('brave');
    expect(JSON.stringify(status)).not.toContain('super-secret');
  });

  it('reports why search is unavailable in the status resource', () => {
    const service = new WebResearchService({ lookup, search: selectSearchProvider({}) });
    const status = service.getStatus();
    expect(status.config.searchProvider).toBeNull();
    expect(status.config.searchUnavailable).toContain('BRAVE_SEARCH_API_KEY');
  });
});
