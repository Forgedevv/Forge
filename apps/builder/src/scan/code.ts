/**
 * AST analysis of TS/TSX/JS/JSX files of the free zones (TypeScript parser).
 *
 * Produces findings for: network sinks to non-allowlisted or dynamic URLs,
 * external/inline scripts, wallet and signing APIs, dynamic code, dangerous
 * HTML sinks, navigation to external sites, forbidden imports, access to server
 * secrets, and hidden Solana addresses.
 */

import { builtinModules } from 'node:module';

import ts from 'typescript';

import { isCamelWords, looksRandomBase58 } from './base58.js';
import type { ResolvedConfig } from './config.js';
import {
  Folder,
  UNKNOWN,
  bindingNames,
  memberChain,
  staticPropertyName,
  unwrap,
  type Value,
} from './fold.js';
import {
  forgeExportRule,
  importTarget,
  publicExportNames,
  publicForgeModule,
  resolveLocalImport,
} from './forge-api.js';
import {
  AddressCollector,
  activeHtmlFindings,
  cssFindings,
  decodeEntities,
  hiddenUnicodeFindings,
  scriptUrlFindings,
} from './text.js';
import type { Finding, RuleId } from './types.js';
import { checkUrl, isScriptUrl, truncate, type UrlCandidate, type UrlKind } from './url.js';

/** Wallet, signing and transfer APIs: never allowed outside src/forge/. */
const WALLET_NAMES = new Set([
  'approve',
  'approveChecked',
  'setAuthority',
  'createApproveInstruction',
  'createApproveCheckedInstruction',
  'createSetAuthorityInstruction',
  'createRevokeInstruction',
  'createCloseAccountInstruction',
  'createTransferInstruction',
  'createTransferCheckedInstruction',
  'signAllTransactions',
  'signTransaction',
  'signAndSendTransaction',
  'signAndSendAllTransactions',
  'signMessage',
  'signIn',
  'sendTransaction',
  'sendRawTransaction',
  'sendEncodedTransaction',
  'sendAndConfirmTransaction',
  'sendAndConfirmRawTransaction',
  'Keypair',
  'fromSecretKey',
  'fromSeed',
  'secretKey',
  'SystemProgram',
  'VersionedTransaction',
  'TransactionMessage',
  'TransactionInstruction',
  'transferPoolCreator',
  // Injected wallet providers
  'solana',
  'phantom',
  'solflare',
  'backpack',
]);

/** Dynamic code execution. */
const CODE_NAMES = new Set([
  'eval',
  'execScript',
  'Function',
  'WebAssembly',
  'importScripts',
  'constructor',
]);

/** Network APIs that are never allowed (no legitimate design use). */
const NET_FORBIDDEN = new Set([
  'XMLHttpRequest',
  'ActiveXObject',
  'Worker',
  'SharedWorker',
  'serviceWorker',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'WebTransport',
  'fetchLater',
  // React 19 resource APIs (preinit loads and executes a script)
  'preinit',
  'preinitModule',
  'preload',
  'preloadModule',
  'preconnect',
  'prefetchDNS',
]);

/** Network APIs allowed only as a direct call with a checked URL. */
const NET_SINKS = new Set(['fetch', 'WebSocket', 'EventSource', 'sendBeacon']);

const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);

/**
 * Next.js server-side data hooks. `getServerSideProps` and `getInitialProps` hand page code the
 * raw request and response objects, and a response can be written directly
 * (`res.end('<script>...')`), bypassing every JSX and DOM rule. `getStaticProps` and
 * `getStaticPaths` run on the build server with its environment: what they return is published as
 * public JSON (a server secret read there would be baked into the site). Free-zone pages are
 * static and run no server-side data code: any mention of these names (and of their former
 * `unstable_` names) is refused.
 */
const SERVER_DATA_HOOKS = new Set([
  'getServerSideProps',
  'getInitialProps',
  'getStaticProps',
  'getStaticPaths',
  'unstable_getServerProps',
  'unstable_getServerSideProps',
  'unstable_getStaticProps',
  'unstable_getStaticPaths',
]);
/** Methods that only exist on a server response: refused on any receiver. */
const RESPONSE_ONLY_NAMES = new Set([
  'setHeader',
  'writeHead',
  'appendHeader',
  'removeHeader',
  'flushHeaders',
  'writeContinue',
  'writeEarlyHints',
  'writeProcessing',
  'addTrailers',
  'sendFile',
  'sendStatus',
]);
/**
 * Output methods of a response (and the socket under it), refused on a response receiver, as is
 * any `send*` method.
 */
const RESPONSE_OUTPUT_NAMES = new Set([
  'end',
  'write',
  'pipe',
  'cork',
  'uncork',
  'destroy',
  'json',
  'redirect',
  'status',
  'socket',
  'connection',
]);
/** Response properties whose assignment changes what is sent: refused on any receiver. */
const RESPONSE_PROPS = new Set(['statusCode', 'statusMessage']);
/** Names conventionally given to a response object. */
const RESPONSE_NAMES = new Set(['res', 'response']);

const HTML_SINKS = new Set([
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'createContextualFragment',
  'srcdoc',
  'srcDoc',
  'writeln',
  'setHTMLUnsafe',
  'parseHTMLUnsafe',
  'DOMParser',
  'parseFromString',
  'createHTMLDocument',
  'XSLTProcessor',
  'getAttributeNode',
  'getAttributeNodeNS',
  'dangerouslySetInnerHTML',
]);

/** String values that name a dangerous element. */
const DANGEROUS_TAG_STRINGS = new Set(['script', 'iframe', 'frame', 'frameset', 'embed']);
const DANGEROUS_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'embed',
  'object',
  'base',
  'meta',
  'link',
  'form',
  'portal',
  'applet',
]);

const GLOBAL_OBJECTS = new Set([
  'window',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'document',
  'opener',
]);
/** Properties that return a window object from any receiver. */
const WINDOW_PROPERTIES = new Set(['defaultView', 'contentWindow']);
/** `Object` helpers that read every property of their argument without naming it. */
const OBJECT_READERS = new Set([
  'values',
  'entries',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
]);
/** `Object` helpers that change properties or the prototype of an object without naming them. */
const OBJECT_WRITERS = new Set([
  'setPrototypeOf',
  'defineProperty',
  'defineProperties',
  '__defineGetter__',
  '__defineSetter__',
]);
/** Element properties that load a URL when assigned. */
const URL_PROPS = new Set(['src', 'action', 'formAction', 'poster']);
/** Element properties and attributes holding a list of URLs. */
const URL_LIST_PROPS = new Set(['srcset', 'srcSet', 'ping']);
/** Attributes that load or send to a URL, checked when the element type is unknown. */
const UNKNOWN_TAG_URL_ATTRS = [
  'src',
  'href',
  'action',
  'formaction',
  'data',
  'poster',
  'codebase',
  'background',
];
/** Marker returned by `jsxIntrinsic` for an element whose type cannot be determined. */
const UNKNOWN_TAG = '*';
/** Props commonly used to choose the rendered element of a polymorphic component. */
const POLYMORPHIC_PROPS = new Set(['as', 'component', 'tag', 'element', 'elementtype']);
/** Calls whose result is a component (a const initialized with one is a component reference). */
const COMPONENT_FACTORIES = new Set(['forwardRef', 'memo', 'lazy', 'dynamic', 'createContext']);
/** Modules whose named exports create elements from a type and props. */
const REACT_ELEMENT_MODULES = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
const ELEMENT_FACTORIES = new Set(['createElement', 'jsx', 'jsxs', 'jsxDEV']);
/** Elements whose src only loads media: static URLs are fine, dynamic ones must stay on allowed origins (exfiltration). */
const MEDIA_TAGS = new Set(['img', 'image', 'video', 'audio', 'source', 'track', 'picture']);

const BLOCKED_PACKAGES = new Set([
  'bs58',
  'tweetnacl',
  'ethers',
  'web3',
  'viem',
  'axios',
  'ky',
  'ofetch',
  'got',
  'superagent',
  'node-fetch',
  'cross-fetch',
  'isomorphic-fetch',
  'undici',
  'ws',
  'socket.io-client',
  'request',
  'needle',
]);
/**
 * Internal modules, server rendering, and `react-dom/client` (a second React root mounted from a
 * module side effect would render outside the app shell, past the site mode gate).
 */
const BLOCKED_PREFIXES = ['next/dist/', 'react-dom/server', 'react-dom/client'];
const BLOCKED_SCOPES = [
  '@solana/',
  '@meteora-ag/',
  '@coral-xyz/',
  '@project-serum/',
  '@metaplex-foundation/',
  '@jup-ag/',
  '@wallet-standard/',
  '@noble/',
  '@forge/',
];
const BUILTINS = new Set(builtinModules.map((m: string) => m.replace(/^node:/, '')));

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX; // .js and .jsx may contain JSX in Next.js
}

function collapse(text: string, max = 160): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

function isTypePosition(node: ts.Node): boolean {
  let n: ts.Node | undefined = node.parent;
  let child: ts.Node = node;
  for (let i = 0; n && i < 64; i++) {
    if (ts.isExpressionWithTypeArguments(n)) {
      const clause = n.parent;
      if (ts.isHeritageClause(clause) && ts.isClassLike(clause.parent)) return false;
      return true;
    }
    if (ts.isTypeNode(n)) return true;
    if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return true;
    if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.isTypeOnly) return true;
    if (ts.isImportClause(n) && n.isTypeOnly) return true;
    if (ts.isStatement(n) || ts.isSourceFile(n) || ts.isBlock(n)) return false;
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) &&
      n.type === child
    )
      return true;
    child = n;
    n = n.parent;
  }
  return false;
}

/** Parent skipping parentheses and type-only wrappers. */
function parentOf(node: ts.Node): { parent: ts.Node | undefined; child: ts.Node } {
  let child: ts.Node = node;
  let p = node.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p))
  ) {
    child = p;
    p = p.parent;
  }
  return { parent: p, child };
}

/** The call/new expression for which `node` is the callee, if any. */
function calleeOf(node: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  const { parent, child } = parentOf(node);
  if (
    parent &&
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === child
  )
    return parent;
  return undefined;
}

function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p)) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (
    (ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(p) && (p.propertyName === id || p.name === id)) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isEnumDeclaration(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isJsxAttribute(p)) return false;
  if (
    (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) &&
    p.tagName === id
  )
    return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

function jsxWhitespace(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, ' ');
    if (i > 0) l = l.replace(/^ +/, '');
    if (i < lines.length - 1) l = l.replace(/ +$/, '');
    if (l.length > 0) out.push(l);
  });
  return out.join(' ');
}

function attrName(attr: ts.JsxAttribute): string {
  const n = attr.name;
  return ts.isIdentifier(n) ? ts.idText(n) : `${ts.idText(n.namespace)}:${ts.idText(n.name)}`;
}

function isSafeStaticHtml(html: string): boolean {
  if (activeHtmlFindings(html).length > 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/(?:java|vb)script\s*:/i.test(decodeEntities(html).replace(/[\t\n\r\u0000]/g, '')))
    return false;
  return true;
}

export function analyzeCode(path: string, text: string, config: ResolvedConfig): Finding[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const folder = new Folder(sf);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const consumed = new Set<ts.Node>();
  const addresses = new AddressCollector(text, config);
  const nextScriptNames = new Set<string>(['Script']);
  const nextImageNames = new Set<string>();
  const nextLinkNames = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    const target =
      spec === 'next/script'
        ? nextScriptNames
        : spec === 'next/image' || spec === 'next/legacy/image'
          ? nextImageNames
          : spec === 'next/link'
            ? nextLinkNames
            : null;
    if (!target || !clause) continue;
    if (clause.name) target.add(ts.idText(clause.name));
    if (clause.namedBindings && spec === 'next/script') {
      // Namespace or named imports would allow <S.default src> or createElement(S, ...).
      const names = ts.isNamespaceImport(clause.namedBindings)
        ? [clause.namedBindings.name]
        : clause.namedBindings.elements.map((e) => e.name);
      for (const b of names) {
        findings.push({
          rule: 'external-script',
          key: `external-script|next/script binding ${ts.idText(b)}`,
          line: sf.getLineAndCharacterOfPosition(b.getStart(sf)).line + 1,
          reason: 'next/script must be imported as a default import',
        });
      }
    }
  }

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const snippet = (node: ts.Node): string => collapse(node.getText(sf));
  const add = (rule: RuleId, node: ts.Node, reason: string, detail?: string): void => {
    const dedupe = `${rule}@${node.getStart(sf)}@${reason}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    findings.push({ rule, key: `${rule}|${detail ?? snippet(node)}`, line: lineOf(node), reason });
  };

  const parseDiagnostics =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  for (const d of parseDiagnostics) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const line = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line + 1 : 1;
    findings.push({
      rule: 'parse-error',
      key: `parse|${message}`,
      line,
      reason: `syntax error: ${truncate(message, 80)}`,
    });
  }

  const isDeclared = (name: string): boolean => folder.isDeclared(name);
  const importedScript = (name: string): boolean =>
    sf.statements.some(
      (st) =>
        ts.isImportDeclaration(st) &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        st.moduleSpecifier.text === 'next/script' &&
        st.importClause?.name !== undefined &&
        ts.idText(st.importClause.name) === name,
    );

  /** Names whose every declaration is a component (import, function, class, or const holding one). */
  const componentNames = new Map<string, boolean>();
  const reactNames = new Set<string>();
  /** Local name -> imported name, for named imports from React modules. */
  const reactImports = new Map<string, string>();
  {
    const mark = (id: ts.Identifier | string, isComponent: boolean): void => {
      const name = typeof id === 'string' ? id : ts.idText(id);
      componentNames.set(name, (componentNames.get(name) ?? true) && isComponent);
    };
    const componentInit = (init: ts.Expression | undefined): boolean => {
      if (!init) return false;
      const i = unwrap(init);
      if (ts.isArrowFunction(i) || ts.isFunctionExpression(i) || ts.isClassExpression(i))
        return true;
      // styled.form`...` or memo('form') render an intrinsic element: not treated as a component.
      if (ts.isCallExpression(i)) {
        const callee = unwrap(i.expression);
        const name = ts.isIdentifier(callee)
          ? ts.idText(callee)
          : ts.isPropertyAccessExpression(callee)
            ? ts.idText(callee.name)
            : '';
        const first = i.arguments[0] ? unwrap(i.arguments[0]) : undefined;
        if (!COMPONENT_FACTORIES.has(name) || !first) return false;
        return (
          ts.isArrowFunction(first) ||
          ts.isFunctionExpression(first) ||
          ts.isClassExpression(first) ||
          ts.isIdentifier(first) ||
          ts.isPropertyAccessExpression(first)
        );
      }
      return false;
    };
    const walk = (node: ts.Node): void => {
      if (ts.isImportClause(node) && node.name) mark(node.name, true);
      else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) mark(node.name, true);
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
        mark(node.name, true);
      else if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name))
          mark(
            node.name,
            (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0 &&
              componentInit(node.initializer),
          );
        else for (const n of bindingNames(node.name)) mark(n, false);
      } else if (ts.isParameter(node) || ts.isBindingElement(node)) {
        for (const n of bindingNames(node.name)) mark(n, false);
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    for (const st of sf.statements) {
      if (
        !ts.isImportDeclaration(st) ||
        !ts.isStringLiteral(st.moduleSpecifier) ||
        !REACT_ELEMENT_MODULES.has(st.moduleSpecifier.text)
      )
        continue;
      const clause = st.importClause;
      if (clause?.name) reactNames.add(ts.idText(clause.name));
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) reactNames.add(ts.idText(nb.name));
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements)
          reactImports.set(
            ts.idText(e.name),
            e.propertyName ? e.propertyName.getText(sf) : ts.idText(e.name),
          );
      }
    }
  }
  const isComponentName = (name: string): boolean => componentNames.get(name) === true;

  /**
   * FORGE components loaded on demand: `const X = dynamic(() => import('@/forge/M'))` (or
   * `.then((m) => m.Name)`, or React `lazy`) binds `X` to one export of `M`, checked like a named
   * import. Only the `next/dynamic` default import and React's `lazy`, declared once in the file,
   * are trusted to hand the props of `X` to the loaded component unchanged. Any other `import()`
   * of `src/forge/` exposes the whole module and is refused.
   */
  const loaderClaims = new Map<
    ts.Node,
    { exportName: string; local: string | null; exported: boolean }
  >();
  {
    const declCounts = new Map<string, number>();
    const declare = (name: string): void => {
      declCounts.set(name, (declCounts.get(name) ?? 0) + 1);
    };
    const dynamicNames = new Set<string>();
    for (const st of sf.statements) {
      if (
        !ts.isImportDeclaration(st) ||
        !ts.isStringLiteral(st.moduleSpecifier) ||
        st.moduleSpecifier.text !== 'next/dynamic'
      )
        continue;
      const clause = st.importClause;
      if (clause?.name) dynamicNames.add(ts.idText(clause.name));
      const nb = clause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) {
          if (e.propertyName && moduleExportName(e.propertyName) === 'default')
            dynamicNames.add(ts.idText(e.name));
        }
      }
    }
    const walkDecls = (node: ts.Node): void => {
      if (ts.isImportClause(node) && node.name) declare(ts.idText(node.name));
      else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node))
        declare(ts.idText(node.name));
      else if (ts.isImportEqualsDeclaration(node)) declare(ts.idText(node.name));
      else if (ts.isVariableDeclaration(node) || ts.isParameter(node))
        for (const n of bindingNames(node.name)) declare(n);
      else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name
      )
        declare(ts.idText(node.name));
      ts.forEachChild(node, walkDecls);
    };
    walkDecls(sf);
    const declaredOnce = (name: string): boolean => declCounts.get(name) === 1;
    const isTrustedLoader = (callee: ts.Expression): boolean => {
      const c = unwrap(callee);
      if (ts.isIdentifier(c)) {
        const name = ts.idText(c);
        return declaredOnce(name) && (dynamicNames.has(name) || reactImports.get(name) === 'lazy');
      }
      if (ts.isPropertyAccessExpression(c) && ts.idText(c.name) === 'lazy') {
        const recv = unwrap(c.expression);
        return (
          ts.isIdentifier(recv) && reactNames.has(ts.idText(recv)) && declaredOnce(ts.idText(recv))
        );
      }
      return false;
    };
    const isImportCall = (e: ts.Expression): e is ts.CallExpression =>
      ts.isCallExpression(e) &&
      e.expression.kind === ts.SyntaxKind.ImportKeyword &&
      e.arguments.length === 1;
    /** `() => import('m')` or `() => import('m').then((m) => m.Name)`: the call and the export. */
    const loaderImport = (
      arg: ts.Expression,
    ): { call: ts.CallExpression; exportName: string } | null => {
      const fn = unwrap(arg);
      if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.length > 0)
        return null;
      let body: ts.Expression;
      if (ts.isBlock(fn.body)) {
        const only = fn.body.statements.length === 1 ? fn.body.statements[0] : undefined;
        if (!only || !ts.isReturnStatement(only) || !only.expression) return null;
        body = only.expression;
      } else {
        body = fn.body;
      }
      let e = unwrap(body);
      if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
      if (isImportCall(e)) return { call: e, exportName: 'default' };
      if (!ts.isCallExpression(e) || e.arguments.length !== 1) return null;
      const then = unwrap(e.expression);
      if (!ts.isPropertyAccessExpression(then) || ts.idText(then.name) !== 'then') return null;
      const target = unwrap(then.expression);
      const cb = unwrap(e.arguments[0]!);
      if (!isImportCall(target) || !ts.isArrowFunction(cb) || cb.parameters.length !== 1)
        return null;
      const param = cb.parameters[0]!.name;
      if (!ts.isIdentifier(param) || ts.isBlock(cb.body)) return null;
      const ret = unwrap(cb.body);
      if (!ts.isPropertyAccessExpression(ret)) return null;
      const recv = unwrap(ret.expression);
      if (!ts.isIdentifier(recv) || ts.idText(recv) !== ts.idText(param)) return null;
      return { call: target, exportName: ts.idText(ret.name) };
    };
    const walkLoaders = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] !== undefined &&
        isTrustedLoader(node.expression)
      ) {
        const loaded = loaderImport(node.arguments[0]);
        if (loaded) {
          const { parent, child } = parentOf(node);
          const decl =
            parent &&
            ts.isVariableDeclaration(parent) &&
            parent.initializer === child &&
            ts.isIdentifier(parent.name) &&
            (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0
              ? parent
              : undefined;
          // `export const X = dynamic(...)`: other files would render X unchecked.
          const statement = decl?.parent?.parent;
          const exported =
            statement !== undefined &&
            ts.isVariableStatement(statement) &&
            (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          loaderClaims.set(loaded.call, {
            exportName: loaded.exportName,
            local: decl ? ts.idText(decl.name as ts.Identifier) : null,
            exported,
          });
        }
      }
      ts.forEachChild(node, walkLoaders);
    };
    walkLoaders(sf);
  }
  /** Local names bound to a FORGE component: only rendered as JSX, with the listed props. */
  const forgeComponents = new Map<
    string,
    { module: string; exportName: string; props: readonly string[] }
  >();

  /**
   * Response objects: `res` / `response` (unless every declaration of the name is the result of a
   * `fetch` call), anything destructured from a `res` property, and any variable initialized from
   * one of those. Best effort: the data hooks that hand out the response are refused anyway.
   */
  const responseAliases = new Set<string>();
  const fetchResultNames = new Set<string>();
  /** True when `expr` may be a server response object (or something hanging off one). */
  const isResponseLike = (expr: ts.Expression, depth = 0): boolean => {
    if (depth > 16) return true;
    const n = unwrap(expr);
    if (ts.isIdentifier(n)) {
      const name = ts.idText(n);
      return responseAliases.has(name) || (RESPONSE_NAMES.has(name) && !fetchResultNames.has(name));
    }
    if (ts.isPropertyAccessExpression(n)) {
      return ts.idText(n.name) === 'res' || isResponseLike(n.expression, depth + 1);
    }
    if (ts.isElementAccessExpression(n)) {
      return (
        folder.foldString(n.argumentExpression) === 'res' || isResponseLike(n.expression, depth + 1)
      );
    }
    if (ts.isConditionalExpression(n)) {
      return isResponseLike(n.whenTrue, depth + 1) || isResponseLike(n.whenFalse, depth + 1);
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return isResponseLike(n.left, depth + 1) || isResponseLike(n.right, depth + 1);
      }
      if (op === ts.SyntaxKind.CommaToken) return isResponseLike(n.right, depth + 1);
    }
    return false;
  };
  {
    type DeclKind = 'fetch' | 'other';
    const declKinds = new Map<string, Set<DeclKind>>();
    const record = (name: string, kind: DeclKind): void => {
      if (!RESPONSE_NAMES.has(name)) return;
      const kinds = declKinds.get(name) ?? new Set<DeclKind>();
      kinds.add(kind);
      declKinds.set(name, kinds);
    };
    const isFetchCall = (expr: ts.Expression | undefined): boolean => {
      if (!expr) return false;
      let e = unwrap(expr);
      if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
      if (!ts.isCallExpression(e)) return false;
      const chain = memberChain(e.expression);
      return chain === 'fetch' || chain === 'window.fetch' || chain === 'globalThis.fetch';
    };
    const assigned: Array<{ name: string; init: ts.Expression }> = [];
    const walkDecls = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const name = ts.idText(node.name);
        record(name, isFetchCall(node.initializer) ? 'fetch' : 'other');
        if (node.initializer) assigned.push({ name, init: node.initializer });
      } else if (ts.isBindingElement(node)) {
        const key = node.propertyName
          ? staticPropertyName(node.propertyName, folder)
          : ts.isIdentifier(node.name)
            ? ts.idText(node.name)
            : UNKNOWN;
        if (key === 'res') for (const n of bindingNames(node.name)) responseAliases.add(n);
        for (const n of bindingNames(node.name)) record(n, 'other');
      } else if (ts.isParameter(node)) {
        // `fetch(url).then((res) => res.json())`: the parameter is the fetch result.
        const fn = node.parent;
        const call = fn ? parentOf(fn).parent : undefined;
        const fromFetch =
          ts.isIdentifier(node.name) &&
          (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
          fn.parameters[0] === node &&
          call !== undefined &&
          ts.isCallExpression(call) &&
          call.arguments[0] !== undefined &&
          unwrap(call.arguments[0]) === fn &&
          ts.isPropertyAccessExpression(unwrap(call.expression)) &&
          ts.idText((unwrap(call.expression) as ts.PropertyAccessExpression).name) === 'then' &&
          isFetchCall((unwrap(call.expression) as ts.PropertyAccessExpression).expression);
        for (const n of bindingNames(node.name)) record(n, fromFetch ? 'fetch' : 'other');
      } else if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name !== undefined
      ) {
        record(ts.idText(node.name), 'other');
      } else if (ts.isImportClause(node) && node.name) {
        record(ts.idText(node.name), 'other');
      } else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) {
        record(ts.idText(node.name), 'other');
      } else if (ts.isBinaryExpression(node) && isAssign(node.operatorToken.kind)) {
        const left = unwrap(node.left);
        if (ts.isIdentifier(left)) {
          const name = ts.idText(left);
          record(name, isFetchCall(node.right) ? 'fetch' : 'other');
          assigned.push({ name, init: node.right });
        }
      }
      ts.forEachChild(node, walkDecls);
    };
    walkDecls(sf);
    for (const [name, kinds] of declKinds) {
      if (kinds.size === 1 && kinds.has('fetch')) fetchResultNames.add(name);
    }
    // Aliases of aliases (`const a = ctx.res; const b = a;`), to a fixed point.
    for (let pass = 0; pass < 8; pass++) {
      let grew = false;
      for (const a of assigned) {
        if (!responseAliases.has(a.name) && isResponseLike(a.init)) {
          responseAliases.add(a.name);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }
  const isReactRef = (expr: ts.Expression): boolean => {
    const n = unwrap(expr);
    return (
      ts.isIdentifier(n) &&
      reactNames.has(ts.idText(n)) &&
      componentNames.get(ts.idText(n)) === true
    );
  };
  const isObjectCtor = (expr: ts.Expression): boolean => {
    const n = unwrap(expr);
    if (ts.isIdentifier(n)) return ts.idText(n) === 'Object' && !isDeclared('Object');
    if (ts.isPropertyAccessExpression(n))
      return ts.idText(n.name) === 'Object' && isGlobalRef(n.expression);
    return false;
  };
  /** A receiver that is a plain data literal of this file: indexing it with any key is harmless. */
  const isLiteralData = (expr: ts.Expression): boolean => {
    const n = unwrap(expr);
    if (ts.isIdentifier(n)) return folder.isLiteralConst(ts.idText(n));
    if (ts.isArrayLiteralExpression(n)) return n.elements.every((e) => !ts.isSpreadElement(e));
    if (ts.isObjectLiteralExpression(n)) {
      return n.properties.every(
        (p) =>
          !ts.isSpreadAssignment(p) &&
          (p.name === undefined || staticPropertyName(p.name, folder) !== '__proto__'),
      );
    }
    return false;
  };
  /** A key that is always a number or a boolean at runtime, whatever its operands are (no type information needed). */
  const isNumericKey = (expr: ts.Expression): boolean => {
    const n = unwrap(expr);
    if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n)) return true;
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) return true;
    if (ts.isConditionalExpression(n)) return isNumericKey(n.whenTrue) && isNumericKey(n.whenFalse);
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return isNumericKey(n.left) && isNumericKey(n.right);
      }
      if (op === ts.SyntaxKind.CommaToken) return isNumericKey(n.right);
      return [
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(op);
    }
    if (ts.isCallExpression(n)) {
      const chain = memberChain(n.expression);
      if (chain === null) return false;
      const root = chain.split('.')[0] ?? '';
      if (isDeclared(root)) return false;
      return (
        /^Math\.[a-z0-9]+$/i.test(chain) ||
        ['Number', 'parseInt', 'parseFloat', 'Number.parseInt', 'Number.parseFloat'].includes(chain)
      );
    }
    const v = folder.fold(n);
    return typeof v === 'number' || typeof v === 'boolean';
  };

  const isGlobalRef = (expr: ts.Expression): boolean => {
    const n = unwrap(expr);
    if (ts.isIdentifier(n)) return GLOBAL_OBJECTS.has(ts.idText(n)) && !isDeclared(ts.idText(n));
    if (ts.isPropertyAccessExpression(n)) {
      const name = ts.idText(n.name);
      if (WINDOW_PROPERTIES.has(name)) return true; // document.defaultView, iframe.contentWindow
      return GLOBAL_OBJECTS.has(name) && isGlobalRef(n.expression);
    }
    return false;
  };
  const isDocumentRef = (expr: ts.Expression): boolean => {
    const n = unwrap(expr);
    if (ts.isIdentifier(n)) return ts.idText(n) === 'document' && !isDeclared('document');
    if (ts.isPropertyAccessExpression(n))
      return ['document', 'ownerDocument'].includes(ts.idText(n.name));
    return false;
  };
  const isLocationRef = (expr: ts.Expression): boolean => {
    const n = unwrap(expr);
    if (ts.isIdentifier(n)) return ts.idText(n) === 'location' && !isDeclared('location');
    if (ts.isPropertyAccessExpression(n))
      return (
        ts.idText(n.name) === 'location' &&
        (isGlobalRef(n.expression) || isDocumentRef(n.expression))
      );
    if (ts.isElementAccessExpression(n)) {
      const k = folder.foldString(n.argumentExpression);
      return k === 'location' && (isGlobalRef(n.expression) || isDocumentRef(n.expression));
    }
    return false;
  };

  const urlCheck = (
    sink: string,
    node: ts.Node,
    arg: ts.Expression | undefined,
    kind: UrlKind,
    ruleOverride?: RuleId,
  ): void => {
    if (!arg) return;
    const candidates: UrlCandidate[] = folder.urlCandidates(arg);
    for (const c of candidates) {
      const v = checkUrl(c, kind, config);
      if (v.ok) continue;
      const rule = v.rule === 'javascript-url' ? v.rule : (ruleOverride ?? v.rule);
      const detail = `${sink}|${c.complete ? 'url' : 'prefix'}:${c.text}|${c.complete && c.text ? '' : snippet(arg)}`;
      add(rule, node, `${sink}: ${v.reason}`, detail);
    }
  };

  /**
   * URL lists (`srcset`, `ping`): a dynamic part can append any URL, so only a
   * fully static value is accepted, and each of its URLs is checked unless
   * `staticAllowed` (media in JSX, where a static URL leaks nothing).
   */
  const urlListCheck = (
    sink: string,
    node: ts.Node,
    arg: ts.Expression | undefined,
    rule: RuleId,
    staticAllowed = false,
  ): void => {
    if (!arg) return;
    for (const c of folder.urlCandidates(arg)) {
      if (!c.complete) {
        add(
          rule,
          node,
          `${sink}: URL list with a dynamic part`,
          `${sink}|list|${c.text}|${snippet(arg)}`,
        );
        continue;
      }
      for (const token of decodeEntities(c.text).split(/[\s,]+/)) {
        if (token === '' || /^\d+(?:\.\d+)?[wxh]$/i.test(token)) continue;
        const v = checkUrl({ text: token, complete: true }, 'network', config);
        if (v.ok || (staticAllowed && v.rule !== 'javascript-url')) continue;
        add(
          v.rule === 'javascript-url' ? v.rule : rule,
          node,
          `${sink}: ${v.reason}`,
          `${sink}|url:${token}`,
        );
      }
    }
  };

  /** Imported or re-exported names of a declaration, as text (part of the finding key of a blocked package). */
  const importedNames = (node: ts.Node): string => {
    const out: string[] = [];
    if (ts.isImportDeclaration(node)) {
      const c = node.importClause;
      if (c?.isTypeOnly) out.push('type');
      if (c?.name) out.push(`default:${ts.idText(c.name)}`);
      const nb = c?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) out.push(`*:${ts.idText(nb.name)}`);
      if (nb && ts.isNamedImports(nb))
        for (const e of nb.elements) out.push(e.getText(sf).replace(/\s+/g, ' '));
    } else if (ts.isExportDeclaration(node)) {
      const ec = node.exportClause;
      if (!ec) out.push('*');
      else if (ts.isNamespaceExport(ec)) out.push(`*:${ec.name.getText(sf)}`);
      else for (const e of ec.elements) out.push(e.getText(sf).replace(/\s+/g, ' '));
    } else if (ts.isImportEqualsDeclaration(node)) {
      out.push(`=:${ts.idText(node.name)}`);
    }
    return out.sort().join(',');
  };

  /**
   * An import of a `src/forge/` module (`module`: canonical id) by this free-zone file. Only the
   * public exports of FORGE_PUBLIC_API may be used, by name; anything that exposes the whole
   * module (namespace import, `export *`, `import()`, `require()`) is refused. Finding keys name
   * the module and the export, not the specifier: the same import written another way is the same
   * finding.
   */
  const forgeImportCheck = (node: ts.Node, module: string): void => {
    const id = module.toLowerCase();
    const deny = (at: ts.Node, what: string, reason: string): void =>
      add('forbidden-import', at, reason, `forge-import|${id}|${what}`);
    const isPublic = publicForgeModule(module) !== undefined;
    const internal = (what: string): string =>
      `${what} ${module}: this module is internal to FORGE (free-zone code may only use the public FORGE components and helpers)`;
    const whole = (at: ts.Node, what: string, form: string): void =>
      deny(
        at,
        what,
        isPublic
          ? `${form} of ${module} is not allowed: import its public exports by name (${publicExportNames(module).join(', ')})`
          : internal(`${form} of`),
      );
    const sideEffect = (at: ts.Node, typeNamesOnly = false): void => {
      if (isPublic) return;
      deny(
        at,
        'side-effect',
        typeNamesOnly
          ? `import of ${module} with inline type names only (the module may still be loaded): write \`import type { ... }\``
          : internal('import of'),
      );
    };
    /**
     * One export of the module, bound to `local` (`null`: used without a name of this file;
     * `exported`: the binding is itself exported to other files).
     */
    const bind = (
      at: ts.Node,
      exportName: string,
      local: string | null,
      exported = false,
    ): void => {
      const rule = forgeExportRule(module, exportName);
      if (rule === undefined) {
        deny(
          at,
          exportName,
          isPublic
            ? `"${exportName}" is not a public export of ${module} (public: ${publicExportNames(module).join(', ')})`
            : internal(`"${exportName}" of`),
        );
        return;
      }
      if (rule.kind !== 'component') return;
      if (exported) {
        deny(
          at,
          `${exportName}|re-export`,
          `FORGE component "${exportName}" of ${module} may not be re-exported: load and render it in the file that uses it`,
        );
        return;
      }
      if (local === null) {
        deny(
          at,
          `${exportName}|unbound`,
          `FORGE component "${exportName}" of ${module} must be imported (or loaded with dynamic()) into a const of this file and rendered as a JSX element`,
        );
        return;
      }
      forgeComponents.set(local, { module, exportName, props: rule.props });
    };

    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) return sideEffect(node);
      if (clause.isTypeOnly) return;
      let runtime = 0;
      if (clause.name) {
        runtime++;
        bind(clause.name, 'default', ts.idText(clause.name));
      }
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        runtime++;
        whole(nb, '*', 'a namespace import');
      } else if (nb) {
        for (const e of nb.elements) {
          if (e.isTypeOnly) continue;
          runtime++;
          bind(e, moduleExportName(e.propertyName ?? e.name), ts.idText(e.name));
        }
      }
      // Only inline `type` names: the statement may still load the module.
      if (runtime === 0) sideEffect(node, true);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return;
      const ec = node.exportClause;
      if (!ec || ts.isNamespaceExport(ec)) {
        whole(ec ?? node, 'export*', '`export * from`');
        return;
      }
      let runtime = 0;
      for (const e of ec.elements) {
        if (e.isTypeOnly) continue;
        runtime++;
        const name = moduleExportName(e.propertyName ?? e.name);
        if (forgeExportRule(module, name)?.kind === 'component') {
          deny(
            e,
            `${name}|re-export`,
            `FORGE component "${name}" of ${module} may not be re-exported: import and render it where it is used`,
          );
        } else {
          bind(e, name, null);
        }
      }
      if (runtime === 0) sideEffect(node, true);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly) whole(node, 'require', '`import = require()`');
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const claim = loaderClaims.get(node);
      if (claim) bind(node, claim.exportName, claim.local, claim.exported);
      else whole(node, 'import()', 'import() (other than `const X = dynamic(() => import(...))`)');
      return;
    }
    whole(node, 'require', 'require()');
  };

  const moduleCheck = (node: ts.Node, specifierNode: ts.Expression | undefined): void => {
    if (!specifierNode) {
      add('forbidden-import', node, 'module loaded without a static specifier');
      return;
    }
    consumed.add(specifierNode);
    const spec = folder.foldString(specifierNode);
    if (spec === UNKNOWN) {
      add('forbidden-import', node, 'dynamic module specifier');
      return;
    }
    if (spec.includes('!')) {
      add(
        'forbidden-import',
        node,
        `loader syntax in import "${truncate(spec)}"`,
        `import|${spec}`,
      );
      return;
    }
    if (spec.includes('\\')) {
      add('forbidden-import', node, `backslash in import "${truncate(spec)}"`, `import|${spec}`);
      return;
    }
    // Relative and `@/` imports: resolved, then checked against what they really point to.
    const local = resolveLocalImport(path, spec);
    if (local.kind === 'invalid') {
      add('forbidden-import', node, local.reason, `import|${spec}`);
      return;
    }
    if (local.kind === 'file') {
      const target = importTarget(local.path);
      if (target.kind === 'blocked') {
        add('forbidden-import', node, target.reason, `import|local|${local.path.toLowerCase()}`);
      } else if (target.kind === 'forge') {
        forgeImportCheck(node, target.module);
      }
      return;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec) && !spec.startsWith('node:')) {
      add('forbidden-import', node, `URL or scheme import "${truncate(spec)}"`, `import|${spec}`);
      return;
    }
    if (spec.startsWith('/') || spec.startsWith('\\')) {
      add(
        'forbidden-import',
        node,
        `absolute or protocol-relative import "${truncate(spec)}"`,
        `import|${spec}`,
      );
      return;
    }
    const bare = spec.replace(/^node:/, '');
    const pkg = bare.startsWith('@')
      ? bare.split('/').slice(0, 2).join('/')
      : (bare.split('/')[0] ?? bare);
    if (spec.startsWith('node:') || BUILTINS.has(pkg)) {
      add('forbidden-import', node, `Node.js built-in module "${spec}"`, `import|${spec}`);
      return;
    }
    if (BLOCKED_PREFIXES.some((b) => spec.startsWith(b))) {
      add('forbidden-import', node, `internal module "${spec}"`, `import|${spec}`);
      return;
    }
    if (BLOCKED_PACKAGES.has(pkg) || BLOCKED_SCOPES.some((s) => `${pkg}/`.startsWith(s))) {
      // Full specifier and imported names in the key: any change to an existing import is a new finding.
      add(
        'forbidden-import',
        node,
        `package "${pkg}" may not be imported outside src/forge/`,
        `import|${spec}|${importedNames(node)}`,
      );
    }
  };

  const navCheck = (sink: string, node: ts.Node, arg: ts.Expression | undefined): void => {
    if (!arg) return;
    const a = unwrap(arg);
    if (ts.isObjectLiteralExpression(a)) {
      for (const p of a.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          ts.idText(p.name) === 'pathname'
        ) {
          urlCheck(sink, node, p.initializer, 'navigation', 'navigation-external');
        }
        if (ts.isSpreadAssignment(p))
          add('navigation-external', node, `${sink}: dynamic navigation target`);
      }
      return;
    }
    urlCheck(sink, node, arg, 'navigation', 'navigation-external');
  };

  const timerCheck = (name: string, call: ts.CallExpression | ts.NewExpression): void => {
    const arg = call.arguments?.[0];
    if (!arg) return;
    const a = unwrap(arg);
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return;
    if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || ts.isElementAccessExpression(a)) {
      const v = folder.fold(a);
      if (v === UNKNOWN || (typeof v !== 'string' && typeof v !== 'number')) return;
    }
    if (
      ts.isCallExpression(a) &&
      ts.isPropertyAccessExpression(unwrap(a.expression)) &&
      ts.idText((unwrap(a.expression) as ts.PropertyAccessExpression).name) === 'bind'
    )
      return;
    add('dynamic-code', call, `${name} with a string or unknown argument`);
  };

  const htmlCheck = (node: ts.Node, value: ts.Expression | undefined, what: string): void => {
    if (!value) {
      add('dangerous-html', node, `${what} without a static value`);
      return;
    }
    const v = folder.fold(value);
    const html =
      v !== UNKNOWN && typeof v === 'object' && v !== null && !Array.isArray(v)
        ? v.props.get('__html')
        : undefined;
    if (typeof html !== 'string') {
      add('dangerous-html', node, `${what} with a dynamic value`);
      return;
    }
    if (!isSafeStaticHtml(html)) add('dangerous-html', node, `${what} contains active HTML`);
  };

  const setAttributeCheck = (call: ts.CallExpression | ts.NewExpression, ns: boolean): void => {
    const args = call.arguments ?? [];
    const nameNode = args[ns ? 1 : 0];
    const valueNode = args[ns ? 2 : 1];
    const name = nameNode ? folder.foldString(nameNode) : UNKNOWN;
    if (name === UNKNOWN) {
      add('dangerous-html', call, 'setAttribute with a dynamic attribute name');
      return;
    }
    const lower = name.toLowerCase();
    if (lower.startsWith('on') || lower === 'srcdoc') {
      add('dangerous-html', call, `setAttribute("${name}")`);
    } else if (
      ['src', 'action', 'formaction', 'data', 'poster', 'codebase', 'background'].includes(lower)
    ) {
      urlCheck(`setAttribute("${name}")`, call, valueNode, 'network', 'embed-external');
    } else if (lower === 'srcset' || lower === 'ping') {
      urlListCheck(`setAttribute("${name}")`, call, valueNode, 'embed-external');
    } else if (lower === 'href' || lower === 'xlink:href') {
      urlCheck(`setAttribute("${name}")`, call, valueNode, 'navigation', 'navigation-external');
    }
  };

  /** Props object of an element whose type is unknown: the URL attributes of every element are checked. */
  const unknownTagPropsCheck = (
    call: ts.CallExpression | ts.NewExpression,
    props: ts.Expression | undefined,
  ): void => {
    if (!props) return;
    const p = unwrap(props);
    if (
      p.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(p) && ts.idText(p) === 'undefined')
    )
      return;
    if (!ts.isObjectLiteralExpression(p)) {
      add(
        'embed-external',
        call,
        'createElement of a dynamic element type with props that cannot be checked',
      );
      return;
    }
    for (const prop of p.properties) {
      if (ts.isSpreadAssignment(prop)) {
        add('embed-external', call, 'createElement of a dynamic element type with spread props');
        continue;
      }
      const key = prop.name ? staticPropertyName(prop.name, folder) : UNKNOWN;
      if (key === UNKNOWN) {
        add(
          'embed-external',
          call,
          'createElement of a dynamic element type with a computed prop name',
        );
        continue;
      }
      const lower = key.toLowerCase();
      const value = ts.isPropertyAssignment(prop)
        ? prop.initializer
        : ts.isShorthandPropertyAssignment(prop)
          ? prop.name
          : undefined;
      if (UNKNOWN_TAG_URL_ATTRS.includes(lower))
        urlCheck(`createElement prop "${key}"`, call, value, 'network', 'embed-external');
      else if (lower === 'srcset' || lower === 'ping')
        urlListCheck(`createElement prop "${key}"`, call, value, 'embed-external');
    }
  };

  const createElementCheck = (call: ts.CallExpression | ts.NewExpression, react: boolean): void => {
    const arg = call.arguments?.[0];
    if (!arg) return;
    const tag = folder.foldString(arg);
    if (tag === UNKNOWN) {
      const a = unwrap(arg);
      if (react && (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a))) {
        const root = ts.isIdentifier(a) ? a : (memberChain(a)?.split('.')[0] ?? '');
        const name = typeof root === 'string' ? root : ts.idText(root);
        if (isComponentName(name)) return; // component reference
        unknownTagPropsCheck(call, call.arguments?.[1]);
        return;
      }
      // DOM createElement (or a receiver not proven to be React): the tag must be known.
      add('dangerous-html', call, 'createElement with a dynamic element type');
      return;
    }
    const lower = tag.toLowerCase();
    if (lower === 'script') add('inline-script', call, 'script element created from code');
    else if (DANGEROUS_TAGS.has(lower))
      add('embed-external', call, `<${lower}> element created from code`);
  };

  const globalValueCheck = (node: ts.Expression, label: string): void => {
    const { parent, child } = parentOf(node);
    if (!parent) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === child) return;
    if (ts.isElementAccessExpression(parent) && parent.expression === child) return;
    if (ts.isTypeOfExpression(parent)) return;
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        (op === ts.SyntaxKind.InKeyword && parent.right === child) ||
        (op === ts.SyntaxKind.InstanceOfKeyword && parent.right === child)
      ) {
        return;
      }
    }
    add('global-access', node, `"${label}" used as a value (aliasing a global object)`);
  };

  /** True for an object literal whose properties are all named statically (no spread, accessor or `__proto__`). */
  const isPlainLiteral = (expr: ts.Expression): expr is ts.ObjectLiteralExpression => {
    const n = unwrap(expr);
    return ts.isObjectLiteralExpression(n) && isLiteralData(n);
  };

  /** `Object.assign(target, ...sources)`: copies every property of the sources onto the target. */
  const objectAssignCheck = (call: ts.CallExpression | ts.NewExpression): void => {
    for (const src of (call.arguments ?? []).slice(1)) {
      const s = unwrap(src);
      if (!isPlainLiteral(s)) {
        add(
          'global-access',
          call,
          'Object.assign with a source that is not an inline object literal',
        );
        continue;
      }
      for (const prop of s.properties) {
        const key = prop.name ? staticPropertyName(prop.name, folder) : UNKNOWN;
        if (key === UNKNOWN) {
          add('global-access', call, 'Object.assign with a computed property name');
          continue;
        }
        const value = ts.isPropertyAssignment(prop)
          ? prop.initializer
          : ts.isShorthandPropertyAssignment(prop)
            ? prop.name
            : undefined;
        const lower = key.toLowerCase();
        const urlProp =
          URL_PROPS.has(key) ||
          ['src', 'action', 'formaction', 'poster', 'data', 'codebase'].includes(lower);
        if (
          (urlProp || URL_LIST_PROPS.has(key) || lower === 'href' || lower.startsWith('on')) &&
          !value
        ) {
          add('dangerous-html', call, `Object.assign: accessor or method "${key}"`);
        } else if (lower.startsWith('on')) {
          add('dangerous-html', call, `Object.assign sets event handler "${key}"`);
        } else if (urlProp) {
          urlCheck(`Object.assign ${key}`, call, value, 'network', 'embed-external');
        } else if (URL_LIST_PROPS.has(key) || lower === 'srcset' || lower === 'ping') {
          urlListCheck(`Object.assign ${key}`, call, value, 'embed-external');
        } else if (lower === 'href') {
          urlCheck('Object.assign href', call, value, 'navigation', 'navigation-external');
        }
      }
    }
  };

  /** `Object.values(x)`, `Object.setPrototypeOf(...)`...: reflection reaching properties without naming them. */
  const objectReflectionCheck = (name: string, access: ts.Expression, nameNode: ts.Node): void => {
    const callee = calleeOf(access);
    if (!OBJECT_READERS.has(name) && !OBJECT_WRITERS.has(name) && name !== 'assign') return;
    if (!callee) {
      add('global-access', nameNode, `Object.${name} used indirectly`);
      return;
    }
    if (OBJECT_WRITERS.has(name)) {
      add(
        'global-access',
        callee,
        `Object.${name} (changes properties or prototype without naming them)`,
      );
    } else if (name === 'assign') {
      objectAssignCheck(callee);
    } else {
      const target = callee.arguments?.[0];
      if (!target || !isLiteralData(target))
        add(
          'global-access',
          callee,
          `Object.${name} on a value that is not a data literal of this file`,
        );
    }
  };

  /** Handles `location` (identifier or global.location member). */
  const locationCheck = (node: ts.Expression): void => {
    const { parent, child } = parentOf(node);
    if (!parent) return;
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === child &&
      isAssign(parent.operatorToken.kind)
    ) {
      navCheck('location assignment', parent, parent.right);
      return;
    }
    let prop: string | undefined;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === child)
      prop = ts.idText(parent.name);
    else if (ts.isElementAccessExpression(parent) && parent.expression === child) {
      const k = folder.foldString(parent.argumentExpression);
      if (k === UNKNOWN) return; // reported as a dynamic access elsewhere
      prop = k;
    }
    if (prop !== undefined) {
      const access = parent as ts.Expression;
      const up = parentOf(access);
      if (
        up.parent &&
        ts.isBinaryExpression(up.parent) &&
        up.parent.left === up.child &&
        isAssign(up.parent.operatorToken.kind)
      ) {
        if (prop === 'href') navCheck('location.href assignment', up.parent, up.parent.right);
        else if (!['pathname', 'search', 'hash'].includes(prop))
          add('navigation-external', up.parent, `assignment to location.${prop}`);
      } else if ((prop === 'assign' || prop === 'replace') && calleeOf(access)) {
        navCheck(`location.${prop}`, access, calleeOf(access)?.arguments?.[0]);
      }
      return;
    }
    globalValueCheck(node, 'location');
  };

  const serverHookFinding = (name: string, node: ts.Node): void =>
    add(
      'server-response',
      node,
      `"${name}" is not allowed: pages are static (server-side data code can write the raw response or publish server values)`,
    );

  /** Rules for a property name used on some receiver (`recv.name`, `recv['name']`). */
  const memberRules = (
    name: string,
    access: ts.Expression,
    receiver: ts.Expression,
    nameNode: ts.Node,
  ): void => {
    const callee = calleeOf(access);
    if (WALLET_NAMES.has(name))
      add('wallet-api', nameNode, `wallet/signing API "${name}" is not allowed outside src/forge/`);
    if (SERVER_DATA_HOOKS.has(name)) serverHookFinding(name, nameNode);
    if (RESPONSE_ONLY_NAMES.has(name))
      add('server-response', nameNode, `server response manipulation (${name})`);
    if (name === 'res') {
      add('server-response', nameNode, 'access to the server response object ("res")');
    } else if (
      (RESPONSE_OUTPUT_NAMES.has(name) || /^send/.test(name)) &&
      isResponseLike(receiver) &&
      // `status` is also a plain property: reading it is fine, calling it is not.
      (name !== 'status' || callee !== undefined)
    ) {
      add('server-response', nameNode, `server response output (res.${name})`);
    }
    if (CODE_NAMES.has(name)) add('dynamic-code', nameNode, `"${name}" (dynamic code execution)`);
    if (name === '__proto__') add('dynamic-code', nameNode, '"__proto__" access');
    if (NET_FORBIDDEN.has(name)) add('network-api-forbidden', nameNode, `"${name}" is not allowed`);
    if (HTML_SINKS.has(name)) add('dangerous-html', nameNode, `HTML sink "${name}"`);
    if (name === 'write' && isDocumentRef(receiver))
      add('dangerous-html', nameNode, 'document.write');
    if (NET_SINKS.has(name)) {
      if (callee) urlCheck(name, callee, callee.arguments?.[0], 'network');
      else add('network-api-forbidden', nameNode, `"${name}" used indirectly`);
    }
    if (TIMERS.has(name)) {
      if (callee) timerCheck(name, callee);
      else if (isGlobalRef(receiver)) add('dynamic-code', nameNode, `"${name}" used indirectly`);
    }
    if (name === 'process' && isGlobalRef(receiver))
      add('server-secret', nameNode, 'access to process from client/page code');
    if (name === 'location' && (isGlobalRef(receiver) || isDocumentRef(receiver)))
      locationCheck(access);
    if (GLOBAL_OBJECTS.has(name) && isGlobalRef(receiver)) globalValueCheck(access, name);
    // document.defaultView, iframe.contentWindow: a window object, whatever the receiver.
    if (WINDOW_PROPERTIES.has(name)) globalValueCheck(access, name);
    if (isObjectCtor(receiver)) objectReflectionCheck(name, access, nameNode);
    if (
      ['createAttribute', 'createAttributeNS', 'setAttributeNode', 'setAttributeNodeNS'].includes(
        name,
      )
    ) {
      add(
        'dangerous-html',
        nameNode,
        `"${name}" (attribute set without a checkable name and value)`,
      );
    }
    if (
      (name === 'createElement' || name === 'createElementNS') &&
      !callee &&
      !isReactRef(receiver)
    ) {
      add('dangerous-html', nameNode, `${name} used indirectly`);
    }
    if (name === 'open' && isGlobalRef(receiver)) {
      if (callee) navCheck('window.open', callee, callee.arguments?.[0]);
      else add('global-access', nameNode, 'window.open used indirectly');
    }
    if (callee) {
      const recvChain = memberChain(receiver) ?? '';
      const last = recvChain.split('.').pop() ?? '';
      if (['push', 'replace', 'prefetch'].includes(name) && /router$/i.test(last))
        navCheck(`router.${name}`, callee, callee.arguments?.[0]);
      if (name === 'redirect' || name === 'permanentRedirect')
        navCheck(name, callee, callee.arguments?.[0]);
      if (name === 'pipe' && (callee.arguments ?? []).some((a) => isResponseLike(a)))
        add('server-response', callee, 'stream piped into the server response');
      if (name === 'setAttribute' || name === 'setAttributeNS')
        setAttributeCheck(callee, name === 'setAttributeNS');
      if (name === 'createElement' || name === 'createElementNS') {
        if (name === 'createElementNS') {
          const tag = callee.arguments?.[1] ? folder.foldString(callee.arguments[1]) : UNKNOWN;
          if (tag === UNKNOWN || DANGEROUS_TAGS.has(tag.toLowerCase()))
            add('dangerous-html', callee, 'createElementNS with a dangerous or dynamic tag');
        } else {
          createElementCheck(callee, isReactRef(receiver));
        }
      }
      if (ELEMENT_FACTORIES.has(name) && name !== 'createElement' && isReactRef(receiver))
        createElementCheck(callee, true);
      if (name === 'cloneElement') unknownTagPropsCheck(callee, callee.arguments?.[1]);
      if (name === 'resolve' && memberChain(receiver) === 'require')
        add('forbidden-import', callee, 'require.resolve');
    }
  };

  const nameAsString = (text: string, node: ts.Node): void => {
    if (WALLET_NAMES.has(text))
      add('wallet-api', node, `wallet/signing API name "${text}" used as a string`);
    if (CODE_NAMES.has(text)) add('dynamic-code', node, `"${text}" used as a string`);
    if (NET_FORBIDDEN.has(text) || NET_SINKS.has(text))
      add('network-api-forbidden', node, `network API name "${text}" used as a string`);
    if (HTML_SINKS.has(text))
      add('dangerous-html', node, `HTML sink name "${text}" used as a string`);
    if (text === '__proto__') add('dynamic-code', node, '"__proto__" used as a string');
    if (SERVER_DATA_HOOKS.has(text)) serverHookFinding(text, node);
    if (DANGEROUS_TAG_STRINGS.has(text.toLowerCase())) {
      add(
        text.toLowerCase() === 'script' ? 'inline-script' : 'embed-external',
        node,
        `element name "${text}" used as a string`,
      );
    }
  };

  const stringValue = (text: string, node: ts.Node, variant: string): void => {
    nameAsString(text, node);
    if (isScriptUrl(text)) add('javascript-url', node, 'javascript: URL');
    const line = lineOf(node);
    addresses.run(variant, text, line);
    addresses.encoded(variant, text, line);
    if (looksRandomBase58(text.trim())) addresses.fragments(variant, text.trim(), line);
    // Stylesheet text in code (<style>, styled-jsx, CSS-in-JS): same URL rules as .css files.
    if (/@import|url\s*\(/i.test(text) && (text.includes('{') || /@import/i.test(text))) {
      for (const f of cssFindings(text, config)) add(f.rule, node, f.reason, `css|${f.key}`);
    }
  };

  const handleIdentifier = (id: ts.Identifier): void => {
    const name = ts.idText(id);
    const p = id.parent;
    if (!p) return;
    if (ts.isPropertyAccessExpression(p) && p.name === id) {
      memberRules(name, p, p.expression, id);
      return;
    }
    if (
      (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) &&
      p.tagName === id
    )
      return;
    // Declarations, export specifiers, object keys, class members...: wherever the name appears.
    if (SERVER_DATA_HOOKS.has(name)) serverHookFinding(name, id);
    if (
      name === 'res' &&
      ts.isBindingElement(p) &&
      (p.propertyName === id || (p.propertyName === undefined && p.name === id))
    ) {
      add('server-response', id, 'destructuring of the server response object ("res")');
    }
    if (
      nextScriptNames.has(name) &&
      isValueReference(id) &&
      !isTypePosition(id) &&
      (name !== 'Script' || !isDeclared(name) || importedScript(name))
    ) {
      add('external-script', id, 'next/script used outside a JSX <Script> tag');
    }
    if (ts.isJsxAttribute(p)) {
      if (name === 'dangerouslySetInnerHTML') return; // checked with its value
      if (WALLET_NAMES.has(name))
        add('wallet-api', id, `wallet/signing API "${name}" passed as a prop`);
      return;
    }
    const typePos = isTypePosition(id);
    if (name === '__proto__') add('dynamic-code', id, '"__proto__" (prototype change)');
    if (WALLET_NAMES.has(name))
      add('wallet-api', id, `wallet/signing API "${name}" is not allowed outside src/forge/`);
    if (typePos) return;
    const valueRef = isValueReference(id);
    const callee = calleeOf(id);
    if (CODE_NAMES.has(name)) add('dynamic-code', id, `"${name}" (dynamic code execution)`);
    if (NET_FORBIDDEN.has(name)) add('network-api-forbidden', id, `"${name}" is not allowed`);
    if (HTML_SINKS.has(name)) add('dangerous-html', id, `HTML sink "${name}"`);
    if (NET_SINKS.has(name)) {
      if (callee && valueRef) urlCheck(name, callee, callee.arguments?.[0], 'network');
      else add('network-api-forbidden', id, `"${name}" used indirectly`);
    }
    if (TIMERS.has(name) && valueRef && !isDeclared(name)) {
      if (callee) timerCheck(name, callee);
      else add('dynamic-code', id, `"${name}" used indirectly`);
    }
    if (name === 'require' && !isDeclared(name)) {
      if (callee && valueRef) moduleCheck(callee, callee.arguments?.[0]);
      else add('forbidden-import', id, 'require used indirectly');
    }
    if (
      name === 'createRequire' ||
      name === '__non_webpack_require__' ||
      name === '__webpack_require__'
    )
      add('forbidden-import', id, `"${name}"`);
    if (!valueRef) return;
    if (name === 'process' && !isDeclared(name)) {
      const a = id.parent;
      const b = a?.parent;
      const okEnv =
        a &&
        ts.isPropertyAccessExpression(a) &&
        ts.idText(a.name) === 'env' &&
        b &&
        ts.isPropertyAccessExpression(b) &&
        /^(?:NODE_ENV|NEXT_PUBLIC_[A-Z0-9_]+)$/.test(ts.idText(b.name));
      if (!okEnv && !(a && ts.isTypeOfExpression(a)))
        add('server-secret', id, 'access to process / server environment variables');
    }
    if (GLOBAL_OBJECTS.has(name) && !isDeclared(name)) globalValueCheck(id, name);
    if (name === 'Object' && !isDeclared(name)) globalValueCheck(id, name);
    if (name === 'location' && !isDeclared(name)) locationCheck(id);
    if (name === 'open' && !isDeclared(name)) {
      if (callee) navCheck('open', callee, callee.arguments?.[0]);
      else add('global-access', id, 'window.open used indirectly');
    }
    if (name === 'Reflect' && !isDeclared(name)) add('global-access', id, 'Reflect API');
    const reactName = reactImports.get(name);
    if (
      reactName !== undefined &&
      (ELEMENT_FACTORIES.has(reactName) || reactName === 'cloneElement')
    ) {
      if (!callee) add('dangerous-html', id, `${reactName} used indirectly`);
      else if (reactName === 'cloneElement') unknownTagPropsCheck(callee, callee.arguments?.[1]);
      else createElementCheck(callee, true);
    }
    if ((name === 'redirect' || name === 'permanentRedirect') && callee)
      navCheck(name, callee, callee.arguments?.[0]);
  };

  const handleElementAccess = (ea: ts.ElementAccessExpression): void => {
    const key = folder.foldString(ea.argumentExpression);
    if (key !== UNKNOWN) {
      consumed.add(ea.argumentExpression);
      memberRules(key, ea, ea.expression, ea.argumentExpression);
      return;
    }
    if (
      isGlobalRef(ea.expression) ||
      isDocumentRef(ea.expression) ||
      isLocationRef(ea.expression)
    ) {
      add('global-access', ea, 'dynamic property access on a global object');
    } else if (isNumericKey(ea.argumentExpression)) {
      // Always a number or a boolean: cannot name an API.
    } else if (ts.isCallExpression(unwrap(ea.argumentExpression))) {
      add('global-access', ea, 'property name built at runtime');
    } else if (!isLiteralData(ea.expression)) {
      // Fail closed: the receiver may be a window or document obtained indirectly (event.view, ownerDocument...).
      add(
        'global-access',
        ea,
        'dynamic property access with a key that cannot be checked (use .at(i) for arrays, Map.get, or a const lookup object of this file)',
      );
    }
    const recv = unwrap(ea.expression);
    if (
      ts.isIdentifier(recv) &&
      ['process', 'navigator', 'location'].includes(ts.idText(recv)) &&
      !isDeclared(ts.idText(recv))
    ) {
      add('global-access', ea, `dynamic property access on ${ts.idText(recv)}`);
    }
  };

  /**
   * Intrinsic element name of a JSX tag, `null` for a component, or
   * `UNKNOWN_TAG` when the tag is a value that cannot be folded (it may hold
   * any element name, e.g. a conditional or a prop).
   */
  const jsxIntrinsic = (tag: ts.JsxTagNameExpression): string | null => {
    if (ts.isIdentifier(tag)) {
      const name = ts.idText(tag);
      if (/^[a-z]/.test(name) || name.includes('-')) return name.toLowerCase();
      if (nextScriptNames.has(name)) return 'script';
      if (nextImageNames.has(name)) return 'img';
      if (nextLinkNames.has(name)) return 'a';
      const v = folder.fold(tag);
      if (typeof v === 'string') return v.toLowerCase();
      return isComponentName(name) ? null : UNKNOWN_TAG;
    }
    if (ts.isPropertyAccessExpression(tag)) {
      const last = ts.idText(tag.name);
      if (/^[a-z]/.test(last)) return last.toLowerCase(); // motion.div, etc.
      const v = folder.fold(tag);
      if (typeof v === 'string') return v.toLowerCase();
      const root = memberChain(tag)?.split('.')[0];
      return root !== undefined && isComponentName(root) ? null : UNKNOWN_TAG;
    }
    if (ts.isJsxNamespacedName(tag)) return ts.idText(tag.name).toLowerCase();
    return null;
  };

  const attrCandidatesNode = (attr: ts.JsxAttribute): ts.Expression | undefined => {
    const init = attr.initializer;
    if (!init) return undefined;
    if (ts.isStringLiteral(init)) return init;
    if (ts.isJsxExpression(init)) return init.expression;
    return undefined;
  };

  /**
   * Links and media: any static URL is fine (no data can leak), but a URL with
   * a dynamic part must stay on the site's origin or an allowed host.
   */
  const dynamicOnlyCheck = (
    a: ts.JsxAttribute | undefined,
    tag: string,
    attr: string,
    kind: UrlKind,
    rule: RuleId,
  ): void => {
    if (!a) return;
    const node = attrCandidatesNode(a);
    if (!node || ts.isStringLiteral(node)) return;
    for (const c of folder.urlCandidates(node)) {
      if (c.complete) continue;
      const v = checkUrl(c, kind, config);
      if (!v.ok)
        add(
          v.rule === 'javascript-url' ? v.rule : rule,
          a,
          `<${tag} ${attr}> with a dynamic URL: ${v.reason}`,
          `${tag}|${attr}|${c.text}|${snippet(node)}`,
        );
    }
  };

  const handleJsxElement = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void => {
    const tag = jsxIntrinsic(el.tagName);
    if (tag === null) return;
    const attrs = new Map<string, ts.JsxAttribute>();
    let spread = false;
    for (const a of el.attributes.properties) {
      if (ts.isJsxSpreadAttribute(a)) spread = true;
      else attrs.set(attrName(a).toLowerCase(), a);
    }
    const checkAttr = (attr: string, kind: UrlKind, rule: RuleId): void => {
      const a = attrs.get(attr);
      if (!a) return;
      const node = attrCandidatesNode(a);
      if (!node) return;
      if (ts.isStringLiteral(node)) {
        const v = checkUrl({ text: decodeEntities(node.text), complete: true }, kind, config);
        if (!v.ok)
          add(
            v.rule === 'javascript-url' ? v.rule : rule,
            a,
            `<${tag} ${attr}>: ${v.reason}`,
            `${tag}|${attr}|${node.text}`,
          );
        return;
      }
      urlCheck(`<${tag} ${attr}>`, a, node, kind, rule);
    };
    switch (tag) {
      case UNKNOWN_TAG:
        // The element may be a form, link, object, script...: check every URL attribute strictly.
        if (spread) add('embed-external', el, 'element of a dynamic type with spread attributes');
        for (const attr of UNKNOWN_TAG_URL_ATTRS) checkAttr(attr, 'network', 'embed-external');
        for (const attr of ['srcset', 'ping'])
          urlListCheck(
            `<${snippet(el.tagName)} ${attr}>`,
            el,
            attrs.get(attr) && attrCandidatesNode(attrs.get(attr)!),
            'embed-external',
          );
        break;
      case 'script':
        if (spread) add('external-script', el, '<script> with spread attributes');
        if (attrs.has('src')) checkAttr('src', 'network', 'external-script');
        else add('inline-script', el, 'inline <script> element');
        break;
      case 'iframe':
      case 'frame':
      case 'embed':
      case 'portal':
      case 'applet':
        if (spread) add('embed-external', el, `<${tag}> with spread attributes`);
        checkAttr('src', 'network', 'embed-external');
        break;
      case 'object':
        if (spread) add('embed-external', el, '<object> with spread attributes');
        checkAttr('data', 'network', 'embed-external');
        break;
      case 'form':
        if (spread) add('embed-external', el, '<form> with spread attributes');
        checkAttr('action', 'network', 'embed-external');
        break;
      case 'button':
      case 'input':
        checkAttr('formaction', 'network', 'embed-external');
        break;
      case 'base':
        add('embed-external', el, '<base> element changes URL resolution');
        break;
      case 'a':
      case 'area':
        dynamicOnlyCheck(attrs.get('href'), tag, 'href', 'navigation', 'navigation-external');
        if (attrs.has('ping'))
          urlListCheck(
            `<${tag} ping>`,
            attrs.get('ping')!,
            attrCandidatesNode(attrs.get('ping')!),
            'embed-external',
          );
        break;
      case 'link':
        if (spread) add('embed-external', el, '<link> with spread attributes');
        checkAttr('href', 'network', 'embed-external');
        break;
      case 'meta': {
        const he = attrs.get('httpequiv') ?? attrs.get('http-equiv');
        if (spread) add('navigation-external', el, '<meta> with spread attributes');
        if (he) {
          const node = attrCandidatesNode(he);
          const v = node ? folder.foldString(node) : UNKNOWN;
          if (
            v === UNKNOWN ||
            ['refresh', 'set-cookie', 'content-security-policy'].includes(v.trim().toLowerCase())
          ) {
            add('navigation-external', el, `<meta http-equiv="${v === UNKNOWN ? '?' : v}">`);
          }
        }
        break;
      }
      default:
        if (MEDIA_TAGS.has(tag)) {
          for (const attr of ['src', 'poster'])
            dynamicOnlyCheck(attrs.get(attr), tag, attr, 'network', 'embed-external');
          const srcset = attrs.get('srcset');
          if (srcset)
            urlListCheck(
              `<${tag} srcset>`,
              srcset,
              attrCandidatesNode(srcset),
              'embed-external',
              true,
            );
        }
        break;
    }
  };

  const handleJsxAttribute = (attr: ts.JsxAttribute): void => {
    const name = attrName(attr);
    if (name === 'dangerouslySetInnerHTML') {
      const init = attr.initializer;
      htmlCheck(
        attr,
        init && ts.isJsxExpression(init) ? init.expression : undefined,
        'dangerouslySetInnerHTML',
      );
    } else if (name.toLowerCase() === 'srcdoc') {
      add('dangerous-html', attr, 'srcDoc attribute');
    } else if (POLYMORPHIC_PROPS.has(name.toLowerCase())) {
      // <Box as="form" action=...>: the element type is chosen by a prop.
      const node = attrCandidatesNode(attr);
      const v = node ? folder.foldString(node) : UNKNOWN;
      if (v !== UNKNOWN && DANGEROUS_TAGS.has(v.trim().toLowerCase())) {
        add(
          v.trim().toLowerCase() === 'script' ? 'inline-script' : 'embed-external',
          attr,
          `${name}="${v}" renders a <${v.trim().toLowerCase()}> element`,
        );
      }
    }
  };

  /** Folds composite expressions (concat, templates, calls) that are not part of a larger composite. */
  const isCompositeRoot = (node: ts.Expression): boolean => {
    const { parent } = parentOf(node);
    if (!parent) return true;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return false;
    if (ts.isTemplateSpan(parent)) return false;
    return true;
  };

  const renderJsx = (node: ts.Node): string => {
    if (ts.isJsxText(node)) return jsxWhitespace(decodeEntities(node.text));
    if (ts.isJsxExpression(node)) {
      if (!node.expression) return '';
      const v = folder.fold(node.expression);
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    }
    if (ts.isJsxElement(node)) return node.children.map(renderJsx).join('');
    if (ts.isJsxFragment(node)) return node.children.map(renderJsx).join('');
    return '';
  };

  const numericArray = (arr: ts.ArrayLiteralExpression): number[] | null => {
    if (arr.elements.length !== 32 && arr.elements.length !== 64) return null;
    const v: Value | typeof UNKNOWN = folder.fold(arr);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number')) return null;
    return v as number[];
  };

  /** `url(https://evil/?d=${secret})` built at runtime (inline styles): exfiltration through an image load. */
  const cssUrlInDynamicString = (node: ts.Expression): void => {
    for (const c of folder.urlCandidates(node)) {
      if (c.complete) continue;
      const i = c.text.toLowerCase().lastIndexOf('url(');
      if (i < 0) continue;
      const rest = c.text.slice(i + 4).replace(/^\s*["']?/, '');
      if (rest.length > 0 && !/^[a-z][a-z0-9+.-]*:|^[/\\]{2}/i.test(rest)) continue;
      const v = checkUrl({ text: rest, complete: false }, 'network', config);
      if (!v.ok)
        add(
          'embed-external',
          node,
          `CSS url() with a dynamic URL: ${v.reason}`,
          `cssurl|${rest}|${snippet(node)}`,
        );
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) moduleCheck(node, node.moduleSpecifier);
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'next/script'
      ) {
        const clause = node.importClause;
        if (clause?.name) nextScriptNames.add(ts.idText(clause.name));
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      moduleCheck(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      moduleCheck(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node)) {
      // `import('x')` in a type position: no runtime effect.
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      // `import.meta.webpackContext('../forge')` loads modules by folder: only `.url` is plain data.
      const p = node.parent;
      const prop =
        ts.isPropertyAccessExpression(p) && p.expression === node ? ts.idText(p.name) : '';
      if (prop !== 'url') {
        add(
          'forbidden-import',
          node,
          `import.meta${prop ? `.${prop}` : ''} is not allowed (module loading by the bundler)`,
        );
      }
    }

    if (ts.isIdentifier(node)) handleIdentifier(node);
    else if (ts.isPrivateIdentifier(node)) {
      const name = ts.idText(node).slice(1);
      if (WALLET_NAMES.has(name)) add('wallet-api', node, `wallet/signing API "${name}"`);
    }

    if (ts.isElementAccessExpression(node)) handleElementAccess(node);

    if (ts.isNewExpression(node)) {
      const chain = memberChain(node.expression);
      if ((chain === 'Audio' || chain === 'window.Audio') && node.arguments?.[0]) {
        urlCheck('new Audio', node, node.arguments[0], 'network', 'embed-external');
      }
      if (chain === 'URL' || chain === 'window.URL' || chain === 'globalThis.URL') {
        for (const c of folder.urlCandidates(node)) {
          const v = checkUrl(c, 'network', config);
          if (!v.ok)
            add(
              v.rule,
              node,
              `new URL: ${v.reason}`,
              `URL|${c.text}|${c.complete ? '' : snippet(node)}`,
            );
        }
      }
    }

    if (ts.isBinaryExpression(node) && isAssign(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      let prop: string | undefined;
      let recv: ts.Expression | undefined;
      if (ts.isPropertyAccessExpression(left)) {
        prop = ts.idText(left.name);
        recv = left.expression;
      } else if (ts.isElementAccessExpression(left)) {
        const k = folder.foldString(left.argumentExpression);
        if (k !== UNKNOWN) prop = k;
        recv = left.expression;
      }
      if (prop !== undefined && recv && !isLocationRef(recv) && !isLocationRef(left)) {
        if (URL_PROPS.has(prop))
          urlCheck(`.${prop} assignment`, node, node.right, 'network', 'embed-external');
        if (URL_LIST_PROPS.has(prop))
          urlListCheck(`.${prop} assignment`, node, node.right, 'embed-external');
        if (
          ['value', 'nodeValue', 'textContent'].includes(prop) &&
          /\.attributes\b/.test(recv.getText(sf))
        ) {
          add('dangerous-html', node, 'attribute node value set through element.attributes');
        }
        if (prop === 'href')
          urlCheck('.href assignment', node, node.right, 'navigation', 'navigation-external');
        if (RESPONSE_PROPS.has(prop))
          add('server-response', node, `server response status set (.${prop} assignment)`);
      }
      if (ts.isObjectLiteralExpression(left)) {
        for (const prop of left.properties) {
          const key =
            ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)
              ? staticPropertyName(prop.name, folder)
              : UNKNOWN;
          if (key === 'res')
            add('server-response', prop, 'destructuring of the server response object ("res")');
        }
      }
    }

    if (ts.isComputedPropertyName(node) && folder.foldString(node.expression) === UNKNOWN) {
      const p = node.parent;
      const destructuring =
        ts.isBindingElement(p) ||
        (ts.isPropertyAssignment(p) &&
          ts.isObjectLiteralExpression(p.parent) &&
          ts.isBinaryExpression(p.parent.parent) &&
          p.parent.parent.left === p.parent);
      if (destructuring)
        add('global-access', node, 'destructuring with a computed key that cannot be checked');
    }

    if (ts.isPropertyAssignment(node)) {
      const key =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (key === 'destination') navCheck('redirect destination', node, node.initializer);
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) handleJsxElement(node);
    if (ts.isJsxAttribute(node)) handleJsxAttribute(node);

    if (
      (ts.isJsxElement(node) || ts.isJsxFragment(node)) &&
      !ts.isJsxElement(node.parent) &&
      !ts.isJsxFragment(node.parent)
    ) {
      const rendered = renderJsx(node);
      if (rendered.length >= 32) addresses.run('jsx', rendered, lineOf(node));
      if (rendered.length >= 16) addresses.fragments('jsx', rendered, lineOf(node));
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      literals.push(node.text);
    else if (ts.isTemplateExpression(node)) literals.push(null);

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !consumed.has(node)
    ) {
      const inJsxAttr = ts.isJsxAttribute(node.parent);
      stringValue(inJsxAttr ? decodeEntities(node.text) : node.text, node, 'lit');
    }

    if (
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isTemplateExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isCallExpression(node)
    ) {
      if (!consumed.has(node) && isCompositeRoot(node)) {
        const s = folder.foldString(node);
        if (s !== UNKNOWN && s.length > 0) stringValue(s, node, 'fold');
        if (s === UNKNOWN && !ts.isCallExpression(node)) cssUrlInDynamicString(node);
      }
    }

    if (ts.isArrayLiteralExpression(node)) {
      const nums = numericArray(node);
      if (nums) addresses.bytes(nums, lineOf(node));
      const v = folder.fold(node);
      if (Array.isArray(v) && v.length > 1 && v.every((x) => typeof x === 'string'))
        addresses.joined('array', v as string[], lineOf(node));
    }

    ts.forEachChild(node, visit);
  };
  /** String literals in source order (`null` between template parts): pieces of an address joined at runtime. */
  const literals: (string | null)[] = [];
  visit(sf);
  addresses.joined('literals', literals);

  /**
   * FORGE components bound in this file: every reference must be a JSX tag with listed props (an
   * alias, a wrapper, `createElement`, a re-export or spread props could hand them any prop, such
   * as a raw pool address or a test override).
   */
  const forgeJsxCheck = (
    el: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    local: string,
    b: { module: string; exportName: string; props: readonly string[] },
  ): void => {
    const label = `${b.module.toLowerCase()}#${b.exportName}`;
    const allowed = b.props.filter((p) => p !== 'children');
    const list = allowed.length > 0 ? allowed.join(', ') : 'none';
    for (const a of el.attributes.properties) {
      if (ts.isJsxSpreadAttribute(a)) {
        add(
          'forbidden-import',
          a,
          `spread props on the FORGE component <${local}> (allowed props: ${list})`,
          `forge-usage|${label}|spread`,
        );
        continue;
      }
      const prop = attrName(a);
      if (prop === 'key' || b.props.includes(prop)) continue;
      add(
        'forbidden-import',
        a,
        `prop "${prop}" is not allowed on the FORGE component <${local}> (allowed props: ${list})`,
        `forge-usage|${label}|prop:${prop}`,
      );
    }
    if (ts.isJsxOpeningElement(el) && !b.props.includes('children')) {
      const children = el.parent.children.filter(
        (c) =>
          !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces) &&
          !(ts.isJsxExpression(c) && c.expression === undefined),
      );
      if (children.length > 0) {
        add(
          'forbidden-import',
          el,
          `the FORGE component <${local}> takes no children`,
          `forge-usage|${label}|prop:children`,
        );
      }
    }
  };
  if (forgeComponents.size > 0) {
    const forgeUsage = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const local = ts.idText(node);
        const b = forgeComponents.get(local);
        const p = node.parent;
        if (b && p) {
          const label = `${b.module.toLowerCase()}#${b.exportName}`;
          if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === node) {
            forgeJsxCheck(p, local, b);
          } else if (ts.isExportSpecifier(p)) {
            if ((p.propertyName ?? p.name) === node && !p.parent.parent.moduleSpecifier) {
              add(
                'forbidden-import',
                p,
                `FORGE component "${local}" may not be re-exported: import and render it where it is used`,
                `forge-usage|${label}|re-export`,
              );
            }
          } else if (
            !ts.isJsxClosingElement(p) &&
            !(ts.isVariableDeclaration(p) && p.name === node) &&
            isValueReference(node) &&
            !isTypePosition(node)
          ) {
            add(
              'forbidden-import',
              node,
              `the FORGE component "${local}" may only be rendered as a JSX element (<${local} ... />), not used as a value`,
              `forge-usage|${label}|value:${snippet(p)}`,
            );
          }
        }
      }
      ts.forEachChild(node, forgeUsage);
    };
    forgeUsage(sf);
  }

  for (const acc of folder.accumulatedStrings()) addresses.run('acc', acc, 1);

  const identifiers = new Set<string>();
  const collectIds = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && isCamelWords(ts.idText(n))) identifiers.add(ts.idText(n));
    ts.forEachChild(n, collectIds);
  };
  collectIds(sf);
  addresses.textVariants(identifiers);

  return [
    ...findings,
    ...addresses.findings,
    ...scriptUrlFindings(text),
    ...hiddenUnicodeFindings(text, true),
  ];
}

/** Text of an import/export name (`a`, `default`, or a string name such as `'a-b'`). */
function moduleExportName(name: ts.ModuleExportName): string {
  return ts.isIdentifier(name) ? ts.idText(name) : name.text;
}

function isAssign(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}
