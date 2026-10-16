// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkFetchUrl, isPublicAddress } from '../address';

describe('isPublicAddress', () => {
  it.each([
    '93.184.216.34',
    '1.1.1.1',
    '8.8.8.8',
    '104.16.0.1',
    '2606:4700::1111',
    '2a00:1450:4007:80e::200e',
  ])('accepts the public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.254', 'CGNAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['169.254.169.254', 'link-local / metadata'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped'],
    ['::ffff:127.0.0.1', 'IPv4-mapped'],
    ['64:ff9b::a00:1', 'NAT64'],
    ['fc00::1', 'ULA'],
    ['fd00:ec2::254', 'ULA / metadata'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::1', '6to4'],
    ['2001:0:4136:e378::1', 'Teredo'],
    ['not-an-ip', 'garbage'],
    ['', 'empty'],
  ])('refuses %s (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('checkFetchUrl', () => {
  it('accepts a public https URL', () => {
    expect(
      checkFetchUrl('https://upload.wikimedia.org/wikipedia/commons/a/a9/x.png')?.hostname,
    ).toBe('upload.wikimedia.org');
    expect(checkFetchUrl('https://images.example.com:443/x.png')?.port).toBe('');
  });

  it.each([
    'http://images.example.com/x.png',
    'ftp://images.example.com/x.png',
    'https://user@images.example.com/x.png',
    'https://images.example.com:8443/x.png',
    'https://127.0.0.1/x.png',
    'https://0x7f.1/x.png',
    'https://2130706433/x.png',
    'https://[::1]/x.png',
    'https://[fd00::1]/x.png',
    'https://localhost/x.png',
    'https://localhost./x.png',
    'https://intranet/x.png',
    'https://nas.local/x.png',
    'https://metadata.google.internal/x.png',
    'https://router.home.arpa/x.png',
    `https://images.example.com/${'a'.repeat(2100)}`,
    'not a url',
  ])('refuses %s', (url) => {
    expect(checkFetchUrl(url)).toBeNull();
  });
});
