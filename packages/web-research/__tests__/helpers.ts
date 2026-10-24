/**
 * Test helpers: a fake DNS and a fake `fetch` that never touch the network.
 */
import { vi } from 'vitest';
import type { LookupFn, ResolvedAddress } from '../src/url-validator.js';

/** A lookup that answers from a table; unknown hosts fail like ENOTFOUND. */
export function fakeLookup(table: Record<string, string[]>): LookupFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const addresses = table[hostname];
    if (!addresses) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as Error & { code: string };
      err.code = 'ENOTFOUND';
      throw err;
    }
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }) as LookupFn & ReturnType<typeof vi.fn>;
}

export function html(body: string, title = 'Test Page'): string {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Install a fake global `fetch` routed by exact URL.
 *
 * It honours `redirect` the way real fetch does: with `'manual'` a 3xx is
 * returned to the caller; otherwise the fake follows the Location itself
 * WITHOUT any SSRF check — exactly what real fetch would do. That is what
 * makes the redirect tests meaningful: code that lets fetch follow redirects
 * reaches the "internal" route and the test sees it.
 */
export function installFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fake = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url = String(input);
    for (let hop = 0; hop < 20; hop++) {
      calls.push({ url, init });
      const route = routes[url];
      if (!route) throw new TypeError(`fetch failed: no route for ${url}`);
      const response = await route(init);
      const location = response.headers.get('location');
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && location;
      if (!isRedirect || init?.redirect === 'manual') return response;
      if (init?.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect');
      url = new URL(location!, url).toString();
    }
    throw new TypeError('fetch failed: redirect loop');
  });

  vi.stubGlobal('fetch', fake);
  return { fetch: fake, calls };
}
