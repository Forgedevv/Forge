/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { analyzeCode } from './code.js';
import { resolveConfig } from './config.js';
import { added, scan } from './test-helpers.js';

/**
 * Regression (wave 5 review, reproduced): a free-zone page could write raw HTML to the response
 * (`res.end('<script>...')`) from `getServerSideProps` or `getInitialProps`, bypassing every JSX
 * and DOM rule, and the template CSP keeps 'unsafe-inline' for scripts. Pages are static: the
 * server-side data hooks and the response object are refused in free-zone files.
 */

const PAGE = 'src/pages/promo.tsx';

function violationsOf(source: string, path = PAGE) {
  const result = scan([added(path, source)]);
  return result.ok ? [] : result.violations;
}

const serverResponse = (source: string, path = PAGE) =>
  violationsOf(source, path).filter((v) => v.rule === 'server-response');

describe('server-side output in free-zone pages', () => {
  it('blocks the reproduced payload: getServerSideProps writing a script with res.end', () => {
    const src = [
      `export async function getServerSideProps({ res }: any) {`,
      `  res.end('<html><body><script>window.parent.postMessage(1, "*")</script></body></html>');`,
      `  return { props: {} };`,
      `}`,
      `export default function Promo() {`,
      `  return <main>Promo</main>;`,
      `}`,
    ].join('\n');
    const found = serverResponse(src);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((v) => v.reason).join(' | ')).toMatch(/getServerSideProps/);
    expect(found.map((v) => v.reason).join(' | ')).toMatch(/end/);
  });

  it('blocks the reproduced payload: Page.getInitialProps with ctx.res.end', () => {
    const src = [
      `function Promo() {`,
      `  return <main>Promo</main>;`,
      `}`,
      `Promo.getInitialProps = async (ctx: any) => {`,
      `  ctx.res?.end('<script>document.title = "x"</script>');`,
      `  return {};`,
      `};`,
      `export default Promo;`,
    ].join('\n');
    const found = serverResponse(src);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((v) => v.reason).join(' | ')).toMatch(/getInitialProps/);
  });

  const blocked: Record<string, string> = {
    'getServerSideProps as a const': `export const getServerSideProps = async () => ({ props: {} });`,
    'getServerSideProps through an export specifier': `const load = async () => ({ props: {} }); export { load as getServerSideProps };`,
    'getServerSideProps re-exported from another file': `export { getServerSideProps } from '../components/data';`,
    'getServerSideProps as a string export name': `const load = async () => ({ props: {} }); export { load as 'getServerSideProps' };`,
    'static getInitialProps in a class page': `import { Component } from 'react'; export default class P extends Component { static async getInitialProps() { return {}; } render() { return null; } }`,
    'getInitialProps through a computed member': `function P() { return null; } (P as any)['getInitial' + 'Props'] = async () => ({}); export default P;`,
    'getInitialProps through Object.assign': `function P() { return null; } export default Object.assign(P, { getInitialProps: async () => ({}) });`,
    'res.write': `export const f = (res: any) => { res.write('<script>1</script>'); };`,
    'res.statusCode assignment': `export const f = (res: any) => { res.statusCode = 200; };`,
    'res.flushHeaders': `export const f = (res: any) => res.flushHeaders();`,
    'res.send': `export const f = (res: any) => res.send('<script>1</script>');`,
    'res.json': `export const f = (res: any) => res.json({ ok: true });`,
    'res.redirect': `export const f = (res: any) => res.redirect('/x');`,
    'stream piped into the response': `export const f = (s: any, res: any) => s.pipe(res);`,
    'destructured and renamed response': `export const f = ({ res: out }: any) => out.end('<script>1</script>');`,
    'response through ctx.res alias': `export const f = (ctx: any) => { const r = ctx.res; r.end('x'); };`,
    'response through a computed key': `export const f = (ctx: any) => ctx['r' + 'es'].end('x');`,
    'response socket write': `export const f = (res: any) => res.socket.write('HTTP/1.1 200 OK');`,
    'end method taken off the response': `export const f = (res: any) => { const end = res.end; end.call(res, 'x'); };`,
    'writeHead on any receiver': `export const f = (o: any) => o.writeHead(200);`,
    'a then callback on something else than fetch': `export const f = (p: any) => p.then((res: any) => res.end('x'));`,
  };
  for (const [name, src] of Object.entries(blocked)) {
    it(`blocks: ${name}`, () => {
      expect(serverResponse(src).length, src).toBeGreaterThan(0);
    });
  }

  it('also blocks it in components (any free-zone file)', () => {
    expect(
      serverResponse(`export const f = (ctx: any) => ctx.res.end('x');`, 'src/components/Hero.tsx')
        .length,
    ).toBeGreaterThan(0);
  });

  const allowed: Record<string, string> = {
    'getStaticProps (build time, no response object)': `export const getStaticProps = async () => ({ props: { n: 1 }, revalidate: 60 });`,
    'json of a same-origin fetch result': `export async function load() { const res = await fetch('/api/x'); return res.json(); }`,
    'response of a same-origin fetch': `export async function load() { const response = await fetch('/api/x'); return response.status === 200 ? response.json() : null; }`,
    'json of a fetch result in a then callback': `export const load = () => fetch('/api/x').then((res) => res.json());`,
    'a write method on another object': `export const f = (log: { write(s: string): void }) => log.write('x');`,
    'a variable named res from another call': `export const f = async (api: any) => { const res = await api.list(); return Object.assign(res, { n: 1 }); };`,
  };
  for (const [name, src] of Object.entries(allowed)) {
    it(`allows: ${name}`, () => {
      expect(serverResponse(src), src).toEqual([]);
    });
  }
});

/** Free-zone code files of the template (what the agent starts from). */
const TEMPLATE_ROOT = fileURLToPath(new URL('../../../launchpad-template', import.meta.url));
const FREE_ZONES = ['src/pages', 'src/components', 'src/content', 'src/theme'];

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...codeFiles(path));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('the template free zones are not affected', () => {
  it('no template page or component uses the server response', () => {
    const config = resolveConfig({});
    const files = FREE_ZONES.flatMap((z) => codeFiles(join(TEMPLATE_ROOT, z)))
      .map((f) => relative(TEMPLATE_ROOT, f).replace(/\\/g, '/'))
      .filter((p) => !p.startsWith('src/pages/api/'));
    expect(files.length).toBeGreaterThan(10);
    const offending: string[] = [];
    for (const path of files) {
      const text = readFileSync(join(TEMPLATE_ROOT, path), 'utf8');
      for (const f of analyzeCode(path, text, config)) {
        if (f.rule === 'server-response') offending.push(`${path}:${f.line} ${f.reason}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
