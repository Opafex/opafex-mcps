/**
 * Redirects are followed by hand and every hop is SSRF-checked again.
 *
 * The fake fetch (helpers.ts) follows redirects itself, with no check, unless
 * the caller asks for `redirect: 'manual'` — just like real fetch. So if the
 * service stopped re-validating hops, these tests would see the "internal"
 * page come back instead of a refusal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebResearchService } from '../src/web-research-service.js';
import { fakeLookup, installFetch, htmlResponse, redirectResponse, html } from './helpers.js';

const lookup = fakeLookup({
  'public.example': ['93.184.216.34'],
  'other.example': ['93.184.216.35'],
  'sneaky.example': ['::1'],
});

function makeService(extra: Partial<ConstructorParameters<typeof WebResearchService>[0]> = {}) {
  return new WebResearchService({
    lookup,
    search: { status: 'unavailable', reason: 'not used here' },
    ...extra,
  });
}

const SECRET = html('<p>AccessKeyId: AKIA-INTERNAL-SECRET</p>', 'metadata');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('redirect handling', () => {
  it('refuses a public URL that 302s to the cloud metadata endpoint', async () => {
    const { calls } = installFetch({
      'https://public.example/go': () => redirectResponse('http://169.254.169.254/latest/meta-data/'),
      'http://169.254.169.254/latest/meta-data/': () => htmlResponse(SECRET),
    });

    await expect(makeService().fetchWebpage('https://public.example/go')).rejects.toThrow(/169\.254\.169\.254/);
    // The metadata endpoint was never requested
    expect(calls.map((c) => c.url)).toEqual(['https://public.example/go']);
  });

  it('refuses a redirect to a hostname that resolves to ::1', async () => {
    const { calls } = installFetch({
      'https://public.example/go': () => redirectResponse('https://sneaky.example/admin', 301),
      'https://sneaky.example/admin': () => htmlResponse(SECRET),
    });

    await expect(makeService().fetchWebpage('https://public.example/go')).rejects.toThrow(/::1/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    installFetch({
      'https://public.example/go': () => redirectResponse('file:///etc/passwd'),
    });
    await expect(makeService().fetchWebpage('https://public.example/go')).rejects.toThrow(/Blocked protocol/);
  });

  it('re-checks every hop, not just the first and last', async () => {
    const { calls } = installFetch({
      'https://public.example/1': () => redirectResponse('https://other.example/2', 307),
      'https://other.example/2': () => redirectResponse('http://127.0.0.1/3', 308),
      'http://127.0.0.1/3': () => redirectResponse('https://public.example/final'),
      'https://public.example/final': () => htmlResponse(html('<p>fine</p>')),
    });

    await expect(makeService().fetchWebpage('https://public.example/1')).rejects.toThrow(/127\.0\.0\.1/);
    expect(calls.map((c) => c.url)).toEqual(['https://public.example/1', 'https://other.example/2']);
  });

  it('asks fetch for manual redirects on every request', async () => {
    const { calls } = installFetch({
      'https://public.example/a': () => redirectResponse('/b'),
      'https://public.example/b': () => htmlResponse(html('<p>landed</p>')),
    });

    await makeService().fetchWebpage('https://public.example/a');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init?.redirect).toBe('manual');
    }
  });

  it('follows a safe relative redirect and reports the final URL', async () => {
    installFetch({
      'https://public.example/old': () => redirectResponse('/new?x=1'),
      'https://public.example/new?x=1': () => htmlResponse(html('<p>The new page content</p>', 'New Page')),
    });

    const result = await makeService().fetchWebpage('https://public.example/old');
    expect(result.title).toBe('New Page');
    expect(result.text).toContain('The new page content');
    expect(result.url).toBe('https://public.example/old');
    expect(result.finalUrl).toBe('https://public.example/new?x=1');
  });

  it('omits finalUrl when there was no redirect', async () => {
    installFetch({ 'https://public.example/': () => htmlResponse(html('<p>hi</p>')) });
    const result = await makeService().fetchWebpage('https://public.example/');
    expect(result.finalUrl).toBeUndefined();
  });

  it('caps the redirect chain at maxRedirects (default 5)', async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) {
      routes[`https://public.example/r${i}`] = () => redirectResponse(`/r${i + 1}`);
    }
    const { calls } = installFetch(routes);

    await expect(makeService().fetchWebpage('https://public.example/r0')).rejects.toThrow(/Too many redirects/);
    // The original request plus five followed redirects
    expect(calls).toHaveLength(6);
  });

  it('follows exactly maxRedirects hops successfully', async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 2; i++) {
      routes[`https://public.example/r${i}`] = () => redirectResponse(`/r${i + 1}`);
    }
    routes['https://public.example/r2'] = () => htmlResponse(html('<p>end of chain</p>'));
    installFetch(routes);

    const result = await makeService({ maxRedirects: 2 }).fetchWebpage('https://public.example/r0');
    expect(result.text).toContain('end of chain');
  });

  it('refuses a redirect with no Location header', async () => {
    installFetch({ 'https://public.example/': () => new Response(null, { status: 302 }) });
    await expect(makeService().fetchWebpage('https://public.example/')).rejects.toThrow(/no Location header/);
  });
});
