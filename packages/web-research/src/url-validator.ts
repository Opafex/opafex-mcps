/**
 * URL Validator — SSRF Protection (standalone, no external dependencies).
 *
 * Decides whether a URL is safe to fetch from the machine this server runs
 * on. A URL is refused when:
 *   - its scheme is not http or https;
 *   - its hostname is localhost (or *.localhost) or a known metadata name;
 *   - its hostname is a literal IP (IPv4, or bracketed IPv6) in a
 *     non-public range;
 *   - ANY address its hostname resolves to — IPv4 or IPv6 — is in a
 *     non-public range;
 *   - its hostname cannot be resolved at all (fail closed: an address we
 *     could not check is not an address we will connect to).
 *
 * Every address is checked, not just the first: a host with one public A
 * record and one AAAA record for `::1` is refused, because the HTTP client
 * may pick either.
 *
 * Known limit — DNS rebinding: this validates the addresses at check time,
 * and `fetch` resolves the hostname again when it connects. A hostile DNS
 * server answering with a short TTL can return a public address to the check
 * and a private one to the connection. Closing that needs the connection
 * pinned to the checked address, which global `fetch` does not expose without
 * an extra dependency. Run this server where the network it can reach is
 * already limited if that matters to you.
 */

import { URL } from 'url';
import net from 'node:net';
import dns from 'node:dns';

/** One resolved address, as returned by `dns.promises.lookup(host, { all: true })`. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves a hostname to every address it has. Injectable for tests. */
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface ValidateOptions {
  /** Defaults to `dns.promises.lookup(host, { all: true, verbatim: true })`. */
  lookup?: LookupFn;
}

/**
 * Hostnames refused by name before any lookup. The address check below is the
 * real defence; these exist so the refusal names the problem.
 */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

const defaultLookup: LookupFn = (hostname) =>
  // Read `dns.promises` at call time so tests can spy on it.
  dns.promises.lookup(hostname, { all: true, verbatim: true });

// ============================================================================
// ADDRESS CLASSIFICATION
// ============================================================================

function parseIPv4(ip: string): number[] | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

/**
 * Why an IPv4 address is not publicly routable, or null if it is.
 */
function ipv4BlockReason(octets: number[]): string | null {
  const [a, b, c] = octets;

  // 0.0.0.0/8 ("this network" — 0.0.0.0 reaches localhost on most systems)
  if (a === 0) return 'this-network range 0.0.0.0/8';
  // 10.0.0.0/8
  if (a === 10) return 'private range 10.0.0.0/8';
  // 100.64.0.0/10 (carrier-grade NAT, shared address space)
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT range 100.64.0.0/10';
  // 127.0.0.0/8 (loopback)
  if (a === 127) return 'loopback range 127.0.0.0/8';
  // 169.254.0.0/16 (link-local — includes the 169.254.169.254 cloud metadata endpoint)
  if (a === 169 && b === 254) return 'link-local / cloud metadata range 169.254.0.0/16';
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return 'private range 172.16.0.0/12';
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 0) return 'reserved range 192.0.0.0/24';
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (documentation)
  if (a === 192 && b === 0 && c === 2) return 'documentation range 192.0.2.0/24';
  if (a === 198 && b === 51 && c === 100) return 'documentation range 198.51.100.0/24';
  if (a === 203 && b === 0 && c === 113) return 'documentation range 203.0.113.0/24';
  // 192.168.0.0/16
  if (a === 192 && b === 168) return 'private range 192.168.0.0/16';
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking range 198.18.0.0/15';
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  if (a >= 224) return 'multicast / reserved range 224.0.0.0/3';

  return null;
}

/**
 * Parse an IPv6 address into its eight 16-bit groups. Handles `::`
 * compression, a trailing dotted-quad (`::ffff:127.0.0.1`) and a zone id
 * (`fe80::1%eth0`). Returns null if it is not an IPv6 address.
 */
function parseIPv6(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!net.isIPv6(ip)) return null;

  // Rewrite a trailing dotted-quad as two hex groups
  const lastColon = ip.lastIndexOf(':');
  const last = ip.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;

  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** The IPv4 address carried in two 16-bit groups. */
function embeddedIPv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * Why an IPv6 address is not publicly routable, or null if it is.
 * Addresses that carry an IPv4 address (IPv4-mapped, NAT64, 6to4) are judged
 * by the IPv4 address inside them.
 */
function ipv6BlockReason(g: number[]): string | null {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

  // :: (unspecified)
  if (zeros(0, 8)) return 'unspecified address ::';
  // ::1 (loopback)
  if (zeros(0, 7) && g[7] === 1) return 'IPv6 loopback ::1';

  // ::ffff:0:0/96 (IPv4-mapped) — the connection goes to the IPv4 address inside
  if (zeros(0, 5) && g[5] === 0xffff) {
    const reason = ipv4BlockReason(embeddedIPv4(g[6], g[7]));
    return reason ? `IPv4-mapped address in ${reason}` : null;
  }
  // ::/96 (deprecated IPv4-compatible) — never legitimately public
  if (zeros(0, 6)) return 'IPv4-compatible range ::/96';

  // 64:ff9b::/96 (NAT64 well-known prefix) — judged by the IPv4 address inside
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) {
    const reason = ipv4BlockReason(embeddedIPv4(g[6], g[7]));
    return reason ? `NAT64 address in ${reason}` : null;
  }
  // 64:ff9b:1::/48 (local-use NAT64)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'local-use NAT64 range 64:ff9b:1::/48';

  // 2002::/16 (6to4) — judged by the IPv4 address in groups 1-2
  if (g[0] === 0x2002) {
    const reason = ipv4BlockReason(embeddedIPv4(g[1], g[2]));
    return reason ? `6to4 address in ${reason}` : null;
  }
  // 2001::/32 (Teredo — the IPv4 address inside is obfuscated)
  if (g[0] === 0x2001 && g[1] === 0) return 'Teredo range 2001::/32';
  // 2001:db8::/32 (documentation)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation range 2001:db8::/32';

  // fc00::/7 (unique local)
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local range fc00::/7';
  // fe80::/10 (link-local)
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local range fe80::/10';
  // fec0::/10 (deprecated site-local)
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local range fec0::/10';
  // ff00::/8 (multicast)
  if ((g[0] & 0xff00) === 0xff00) return 'multicast range ff00::/8';

  // Everything still standing must be global unicast, 2000::/3
  if ((g[0] & 0xe000) !== 0x2000) return 'non-global range (outside 2000::/3)';

  return null;
}

/**
 * Why an IP address (IPv4 or IPv6) must not be fetched, or null if it is a
 * public address. A string that is not an IP address at all is refused.
 */
export function blockedAddressReason(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return ipv4BlockReason(v4);
  const v6 = parseIPv6(ip);
  if (v6) return ipv6BlockReason(v6);
  return 'not a valid IP address';
}

// ============================================================================
// URL VALIDATION
// ============================================================================

/**
 * Validate a URL is safe for server-side fetching.
 * Blocks non-HTTP schemes, localhost, metadata endpoints, literal private IPs
 * and hostnames that resolve (on ANY record) to a private IP. Fails closed
 * when the hostname cannot be resolved.
 *
 * @returns the parsed URL
 * @throws Error if the URL is not safe
 */
export async function validateExternalURL(url: string, options: ValidateOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  // Only allow http and https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  // WHATWG URL parsing has already lower-cased the host and canonicalised odd
  // IPv4 spellings (http://2130706433/, http://0x7f.1/ → 127.0.0.1). IPv6
  // literals keep their brackets; a trailing dot is a valid FQDN spelling.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }
  if (!hostname) {
    throw new Error('URL has no hostname');
  }

  // Block localhost variants
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Requests to localhost are not allowed');
  }

  // Block cloud metadata hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('Requests to cloud metadata endpoints are not allowed');
  }

  // Literal IP — check it directly, no lookup
  if (net.isIP(hostname)) {
    const reason = blockedAddressReason(hostname);
    if (reason) {
      throw new Error(`Requests to ${hostname} are not allowed (${reason})`);
    }
    return parsed;
  }

  // Resolve EVERY address (A and AAAA) and refuse if any is non-public
  const lookup = options.lookup ?? defaultLookup;
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new Error(`Could not resolve hostname ${hostname}${code ? ` (${code})` : ''}; refusing to fetch`);
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`Hostname ${hostname} resolved to no addresses; refusing to fetch`);
  }

  for (const { address } of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) {
      throw new Error(`Hostname ${hostname} resolves to ${address} (${reason})`);
    }
  }

  return parsed;
}
