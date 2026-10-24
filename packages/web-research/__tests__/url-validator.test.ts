import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns';
import { validateExternalURL, blockedAddressReason } from '../src/url-validator.js';
import { fakeLookup } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('blockedAddressReason', () => {
  it.each([
    // IPv4
    ['0.0.0.0'],
    ['0.1.2.3'],
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['100.64.0.1'],
    ['100.127.255.255'],
    ['127.0.0.1'],
    ['127.255.0.1'],
    ['169.254.169.254'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.0.0.1'],
    ['192.0.2.10'],
    ['192.168.1.1'],
    ['198.18.0.1'],
    ['198.51.100.7'],
    ['203.0.113.9'],
    ['224.0.0.1'],
    ['239.255.255.250'],
    ['240.0.0.1'],
    ['255.255.255.255'],
    // IPv6
    ['::'],
    ['::1'],
    ['0:0:0:0:0:0:0:1'],
    ['::ffff:127.0.0.1'],
    ['::ffff:7f00:1'],
    ['::ffff:10.0.0.1'],
    ['::ffff:169.254.169.254'],
    ['::ffff:100.64.0.1'],
    ['::127.0.0.1'],
    ['::8.8.8.8'],
    ['64:ff9b::a9fe:a9fe'],
    ['64:ff9b::127.0.0.1'],
    ['64:ff9b:1::1'],
    ['2002:7f00:1::'],
    ['2002:a00:1::1'],
    ['2001::1'],
    ['2001:db8::1'],
    ['fc00::1'],
    ['fd12:3456:789a::1'],
    ['fe80::1'],
    ['fe80::1%eth0'],
    ['febf::1'],
    ['fec0::1'],
    ['ff02::1'],
    ['100::1'],
    ['not-an-ip'],
  ])('blocks %s', (ip) => {
    expect(blockedAddressReason(ip)).not.toBeNull();
  });

  it.each([
    ['8.8.8.8'],
    ['93.184.216.34'],
    ['1.1.1.1'],
    ['100.63.255.255'],
    ['100.128.0.0'],
    ['172.15.255.255'],
    ['172.32.0.1'],
    ['169.253.0.1'],
    ['192.169.0.1'],
    ['223.255.255.255'],
    ['2606:4700:4700::1111'],
    ['2a00:1450:4009:81f::200e'],
    ['::ffff:8.8.8.8'],
    ['64:ff9b::808:808'],
    ['2002:808:808::1'],
  ])('allows %s', (ip) => {
    expect(blockedAddressReason(ip)).toBeNull();
  });
});

describe('validateExternalURL — literal hosts and schemes', () => {
  // A lookup that must never be called for these URLs
  const lookup = fakeLookup({});

  it.each([
    ['http://127.0.0.1/'],
    ['http://localhost/'],
    ['http://LOCALHOST:8080/admin'],
    ['http://localhost./'],
    ['http://app.localhost/'],
    ['http://[::1]/'],
    ['http://[::1]:3000/'],
    ['http://[::]/'],
    ['http://[::ffff:127.0.0.1]/'],
    ['http://[::ffff:7f00:1]/'],
    ['http://[::ffff:169.254.169.254]/'],
    ['http://[fc00::1]/'],
    ['http://[fd00:ec2::254]/'],
    ['http://[fe80::1]/'],
    ['http://[64:ff9b::a9fe:a9fe]/'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://metadata.google.internal/computeMetadata/v1/'],
    ['http://100.64.0.1/'],
    ['http://0.0.0.0/'],
    ['http://0/'],
    ['http://224.0.0.1/'],
    ['http://10.0.0.1/'],
    ['http://172.20.0.1/'],
    ['http://192.168.0.1/'],
    // Alternative IPv4 spellings — WHATWG URL canonicalises them to 127.0.0.1
    ['http://2130706433/'],
    ['http://0x7f.0.0.1/'],
    ['http://0177.0.0.1/'],
    ['http://127.1/'],
  ])('refuses %s', async (url) => {
    await expect(validateExternalURL(url, { lookup })).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['file:///etc/passwd'],
    ['ftp://example.com/file'],
    ['gopher://example.com/'],
    ['data:text/html,hello'],
    ['javascript:alert(1)'],
  ])('refuses non-http scheme %s', async (url) => {
    await expect(validateExternalURL(url, { lookup })).rejects.toThrow(/Blocked protocol/);
  });

  it('refuses a malformed URL', async () => {
    await expect(validateExternalURL('not a url', { lookup })).rejects.toThrow('Invalid URL format');
  });

  it.each([
    ['http://93.184.216.34/'],
    ['https://8.8.8.8/dns-query'],
    ['http://[2606:4700:4700::1111]/'],
    ['http://[::ffff:8.8.8.8]/'],
  ])('allows public literal %s without a lookup', async (url) => {
    await expect(validateExternalURL(url, { lookup })).resolves.toBeDefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('validateExternalURL — DNS', () => {
  it('allows a host whose every address is public', async () => {
    const lookup = fakeLookup({ 'example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
    await expect(validateExternalURL('https://example.com/page', { lookup })).resolves.toBeDefined();
    expect(lookup).toHaveBeenCalledWith('example.com');
  });

  it('refuses when ANY address is private (public A + loopback AAAA)', async () => {
    const lookup = fakeLookup({ 'mixed.example': ['93.184.216.34', '::1'] });
    await expect(validateExternalURL('https://mixed.example/', { lookup })).rejects.toThrow(/::1/);
  });

  it('refuses an IPv6-only host on a unique-local address', async () => {
    const lookup = fakeLookup({ 'v6only.example': ['fd00::1'] });
    await expect(validateExternalURL('https://v6only.example/', { lookup })).rejects.toThrow(/unique-local/);
  });

  it('refuses an IPv6-only host on a link-local address', async () => {
    const lookup = fakeLookup({ 'v6ll.example': ['fe80::abcd'] });
    await expect(validateExternalURL('https://v6ll.example/', { lookup })).rejects.toThrow(/link-local/);
  });

  it('refuses an AAAA record that is an IPv4-mapped private address', async () => {
    const lookup = fakeLookup({ 'mapped.example': ['::ffff:127.0.0.1'] });
    await expect(validateExternalURL('https://mapped.example/', { lookup })).rejects.toThrow(/IPv4-mapped/);
  });

  it('refuses a host that resolves to the cloud metadata address', async () => {
    const lookup = fakeLookup({ 'evil.example': ['169.254.169.254'] });
    await expect(validateExternalURL('http://evil.example/', { lookup })).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('refuses a host that resolves into CGNAT space', async () => {
    const lookup = fakeLookup({ 'cgnat.example': ['100.100.100.200'] });
    await expect(validateExternalURL('http://cgnat.example/', { lookup })).rejects.toThrow(/carrier-grade NAT/);
  });

  it('fails closed when the hostname does not resolve', async () => {
    const lookup = fakeLookup({});
    await expect(validateExternalURL('https://nowhere.example/', { lookup })).rejects.toThrow(
      /Could not resolve hostname nowhere\.example \(ENOTFOUND\)/
    );
  });

  it('fails closed when the lookup returns no addresses', async () => {
    const lookup = fakeLookup({ 'empty.example': [] });
    await expect(validateExternalURL('https://empty.example/', { lookup })).rejects.toThrow(/no addresses/);
  });

  it('strips a trailing dot before resolving', async () => {
    const lookup = fakeLookup({ 'example.com': ['93.184.216.34'] });
    await expect(validateExternalURL('https://example.com./', { lookup })).resolves.toBeDefined();
    expect(lookup).toHaveBeenCalledWith('example.com');
  });

  it('defaults to dns.promises.lookup with all: true (every A and AAAA record)', async () => {
    const spy = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '::1', family: 6 }] as never);
    await expect(validateExternalURL('https://default.example/')).rejects.toThrow(/::1/);
    expect(spy).toHaveBeenCalledWith('default.example', { all: true, verbatim: true });
  });
});
