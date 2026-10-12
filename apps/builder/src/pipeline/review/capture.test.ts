import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  browserArgs,
  datapiFixture,
  findBrowser,
  MAX_CONSOLE_MESSAGES,
  MAX_OVERFLOWING,
  PAGES,
  parseArgs,
  REPORT_FILE,
  routeRequest,
  SHOT_MAX_HEIGHT,
  SHOT_PART_HEIGHT,
  shotFile,
  VIEWPORTS,
} from './capture.mjs';
import * as contract from './contract.js';

describe('capture.mjs mirrors the contract', () => {
  it('has the same pages, viewports, names and limits', () => {
    expect(PAGES).toEqual(contract.REVIEW_PAGES);
    expect(VIEWPORTS).toEqual(contract.REVIEW_VIEWPORTS);
    expect(SHOT_MAX_HEIGHT).toBe(contract.SHOT_MAX_HEIGHT);
    expect(SHOT_PART_HEIGHT).toBe(contract.SHOT_PART_HEIGHT);
    expect(MAX_OVERFLOWING).toBe(contract.MAX_OVERFLOWING);
    expect(MAX_CONSOLE_MESSAGES).toBe(contract.MAX_CONSOLE_MESSAGES);
    expect(REPORT_FILE).toBe(contract.REPORT_FILE);
    for (const part of [1, 2]) {
      expect(shotFile('home', 'mobile', part)).toBe(contract.shotFile('home', 'mobile', part));
    }
  });

  it('is plain Node ESM with no dependency', async () => {
    const source = await readFile(new URL('./capture.mjs', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^node:/);
    expect(source).not.toMatch(/\brequire\(|import\(/);
  });

  it('uses real device emulation, never a window size', async () => {
    const source = await readFile(new URL('./capture.mjs', import.meta.url), 'utf8');
    expect(source).toContain('Emulation.setDeviceMetricsOverride');
    expect(source).toMatch(/deviceScaleFactor: 1/);
    expect(source).not.toMatch(/--window-size/);
    expect(browserArgs({ userDataDir: '/tmp/x', noSandbox: true }).join(' ')).not.toMatch(
      /window-size/,
    );
  });
});

describe('request routing', () => {
  const site = 'http://127.0.0.1:3000';

  it('lets the site through, answers the data API, blocks everything else', () => {
    expect(routeRequest('http://127.0.0.1:3000/_next/static/x.js', site)).toBe('continue');
    expect(routeRequest('data:image/png;base64,AAAA', site)).toBe('continue');
    expect(routeRequest('https://datapi.jup.ag/v1/pools/gems', site)).toBe('fixture');
    for (const url of [
      'https://api.jup.ag/price',
      'https://datapi.jup.ag.evil.example/v1/pools',
      'http://datapi.jup.ag/v1/pools',
      'http://127.0.0.1:3001/',
      'http://localhost:3000/',
      'https://wsrv.nl/?url=x',
      'not a url',
    ]) {
      expect(routeRequest(url, site), url).toBe('block');
    }
  });

  it('serves the day-one empty lists, with CORS', () => {
    const gems = datapiFixture('https://datapi.jup.ag/v1/pools/gems', 'POST', {
      Origin: 'http://127.0.0.1:3000',
    });
    expect(gems.status).toBe(200);
    expect(JSON.parse(gems.body)).toEqual({
      recent: { pools: [] },
      aboutToGraduate: { pools: [] },
      graduated: { pools: [] },
    });
    expect(gems.headers).toContainEqual({
      name: 'access-control-allow-origin',
      value: 'http://127.0.0.1:3000',
    });
    expect(JSON.parse(datapiFixture('https://datapi.jup.ag/v1/pools?x=1', 'GET').body)).toEqual({
      pools: [],
    });
    const preflight = datapiFixture('https://datapi.jup.ag/v1/pools/gems', 'OPTIONS', {
      'Access-Control-Request-Headers': 'content-type',
    });
    expect(preflight).toMatchObject({ status: 204, body: '' });
  });
});

describe('arguments and browser', () => {
  it('parses the container and the local forms', () => {
    expect(
      parseArgs(['--out', '/output', '--site', '/workspace', '--no-browser-sandbox']),
    ).toMatchObject({
      out: '/output',
      site: '/workspace',
      port: 3000,
      noSandbox: true,
      pages: ['home', 'create-pool', 'about', 'creator-fees'],
      viewports: ['desktop', 'mobile'],
    });
    expect(
      parseArgs(['--out', 'x', '--url', 'http://127.0.0.1:3100/about', '--pages', 'home']),
    ).toMatchObject({ url: 'http://127.0.0.1:3100', pages: ['home'] });
  });

  it('refuses bad arguments', () => {
    for (const argv of [
      ['--site', '/workspace'],
      ['--out', 'x'],
      ['--out', 'x', '--site', 'a', '--url', 'http://127.0.0.1:1'],
      ['--out', 'x', '--url', 'https://example.com'],
      ['--out', 'x', '--url', 'http://10.0.0.1:3000'],
      ['--out', 'x', '--site', 'a', '--port', '80'],
      ['--out', 'x', '--site', 'a', '--pages', 'admin'],
      ['--out', 'x', '--site', 'a', '--deadline-ms', '5'],
      ['--out', 'x', '--site', 'a', '--eval', '1'],
    ]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow();
    }
  });

  it('isolates the browser: loopback only, throwaway profile', () => {
    const args = browserArgs({ userDataDir: '/tmp/p', noSandbox: false });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--user-data-dir=/tmp/p');
    expect(args).toContain(
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    );
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).not.toContain('--no-sandbox');
    expect(browserArgs({ userDataDir: '/tmp/p', noSandbox: true })).toContain('--no-sandbox');
  });

  it('finds a local Chrome or Edge', () => {
    const has = (files: string[]) => (f: string) => files.includes(f);
    expect(findBrowser('linux', {}, has(['/usr/bin/chromium']))).toBe('/usr/bin/chromium');
    expect(findBrowser('linux', { FORGE_REVIEW_BROWSER: '/opt/c' }, has([]))).toBe('/opt/c');
    expect(
      findBrowser(
        'win32',
        { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' },
        has(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']),
      ),
    ).toBe('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(findBrowser('darwin', {}, has([]))).toBeNull();
  });
});
