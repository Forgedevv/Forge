/**
 * Static constant folding over a TypeScript AST.
 *
 * Used to see through obfuscation: string concatenation, template literals,
 * `[...].join('')`, `String.fromCharCode`, `atob`, `Buffer.from(..., 'base64')`,
 * same-file `const` bindings, object/array constants. Anything it cannot
 * resolve is `UNKNOWN`, and callers treat an unknown value as unsafe.
 */

import ts from 'typescript';

import { SELF_ORIGIN, type UrlCandidate } from './url.js';

export const UNKNOWN: unique symbol = Symbol('unknown');
export type Unknown = typeof UNKNOWN;

export type Value = string | number | boolean | null | Value[] | ObjectValue;
export interface ObjectValue {
  readonly __object: true;
  readonly props: Map<string, Value | Unknown>;
}

type Result = Value | Unknown;

const MAX_DEPTH = 48;
const MAX_STRING = 200_000;
const MAX_CANDIDATES = 16;

interface Binding {
  name: string;
  /** Number of declarations with this name in the file. */
  declarations: number;
  kind: 'const' | 'let' | 'var' | 'function';
  init?: ts.Expression;
  /** Body expression of a parameterless function returning a single expression. */
  returns?: ts.Expression;
  /** Assigned again after its declaration (other than `+=`). */
  reassigned: boolean;
  /** Right-hand sides of `name += expr`. */
  appends: ts.Expression[];
}

function isObjectValue(v: Result): v is ObjectValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as ObjectValue).__object === true;
}

function makeObject(props: Map<string, Value | Unknown>): ObjectValue {
  return { __object: true, props };
}

/** JS `String(v)` for folded values. */
function toStr(v: Value): string | Unknown {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const e of v) {
      if (e === null) {
        parts.push('');
        continue;
      }
      const s = toStr(e);
      if (s === UNKNOWN) return UNKNOWN;
      parts.push(s);
    }
    return parts.join(',');
  }
  return '[object Object]';
}

function capped(s: string): string | Unknown {
  return s.length > MAX_STRING ? UNKNOWN : s;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) {
      n = n.expression;
    } else {
      return n;
    }
  }
}

/** Name of a property name node, if static. */
export function staticPropertyName(name: ts.PropertyName, folder?: Folder): string | Unknown {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return ts.idText(name);
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && folder) {
    const v = folder.fold(name.expression);
    if (v === UNKNOWN) return UNKNOWN;
    return toStr(v);
  }
  return UNKNOWN;
}

/** Dotted text of a member chain made of identifiers (`window.location.origin`), or null. */
export function memberChain(node: ts.Expression): string | null {
  const n = unwrap(node);
  if (ts.isIdentifier(n)) return ts.idText(n);
  if (ts.isPropertyAccessExpression(n)) {
    const left = memberChain(n.expression);
    return left === null ? null : `${left}.${ts.idText(n.name)}`;
  }
  return null;
}

const SELF_ORIGIN_CHAINS = new Set([
  'window.location.origin',
  'location.origin',
  'globalThis.location.origin',
  'self.location.origin',
  'document.location.origin',
  'window.origin',
]);
const SELF_HREF_CHAINS = new Set(['window.location.href', 'location.href', 'document.location.href', 'document.URL']);

export class Folder {
  private readonly bindings = new Map<string, Binding>();
  private readonly cache = new Map<ts.Node, Result>();
  private readonly inProgress = new Set<ts.Node>();

  constructor(readonly sourceFile: ts.SourceFile) {
    this.collect(sourceFile);
  }

  private declare(name: string, kind: Binding['kind'], init?: ts.Expression, returns?: ts.Expression): void {
    const existing = this.bindings.get(name);
    if (existing) {
      existing.declarations += 1;
      return;
    }
    const b: Binding = { name, declarations: 1, kind, reassigned: false, appends: [] };
    if (init) b.init = init;
    if (returns) b.returns = returns;
    this.bindings.set(name, b);
  }

  private collect(root: ts.Node): void {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          const flags = ts.getCombinedNodeFlags(node);
          const kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
          const init = node.initializer;
          let returns: ts.Expression | undefined;
          if (init && (ts.isArrowFunction(unwrap(init)) || ts.isFunctionExpression(unwrap(init)))) {
            returns = singleReturn(unwrap(init) as ts.ArrowFunction | ts.FunctionExpression);
          }
          this.declare(ts.idText(node.name), kind, init, returns);
        } else {
          // Destructuring: names are declared but not foldable.
          for (const id of bindingNames(node.name)) this.declare(id, 'var');
        }
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        this.declare(ts.idText(node.name), 'function', undefined, singleReturn(node));
      } else if (ts.isParameter(node) || ts.isBindingElement(node)) {
        for (const id of bindingNames(node.name)) this.declare(id, 'var');
      } else if (ts.isClassDeclaration(node) && node.name) {
        this.declare(ts.idText(node.name), 'var');
      } else if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) {
        if (node.name) this.declare(ts.idText(node.name), 'var');
      } else if (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
        if (ts.isIdentifier(node.name)) this.declare(ts.idText(node.name), 'var');
      } else if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        const target = unwrap(node.left);
        if (ts.isIdentifier(target)) {
          const name = ts.idText(target);
          const b = this.bindings.get(name);
          const record = (bb: Binding): void => {
            if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) bb.appends.push(node.right);
            else bb.reassigned = true;
          };
          if (b) record(b);
          else this.pendingAssignments.push({ name, record });
        } else if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
          this.markDestructuringTargets(target);
        }
      } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(unwrap(node.operand))) {
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
          const name = ts.idText(unwrap(node.operand) as ts.Identifier);
          this.pendingAssignments.push({ name, record: (bb) => (bb.reassigned = true) });
        }
      } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isIdentifier(unwrap(node.initializer as ts.Expression))) {
        const name = ts.idText(unwrap(node.initializer as ts.Expression) as ts.Identifier);
        this.pendingAssignments.push({ name, record: (bb) => (bb.reassigned = true) });
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    for (const p of this.pendingAssignments) {
      const b = this.bindings.get(p.name);
      if (b) p.record(b);
    }
    this.pendingAssignments.length = 0;
  }

  private readonly pendingAssignments: { name: string; record: (b: Binding) => void }[] = [];

  private markDestructuringTargets(node: ts.Node): void {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const name = ts.idText(n);
        this.pendingAssignments.push({ name, record: (bb) => (bb.reassigned = true) });
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /** True if the name is declared anywhere in the file (so it is not the global of the same name). */
  isDeclared(name: string): boolean {
    return this.bindings.has(name);
  }

  private binding(name: string): Binding | undefined {
    const b = this.bindings.get(name);
    if (!b || b.declarations !== 1 || b.reassigned || b.appends.length > 0) return undefined;
    return b;
  }

  /** Strict folding: the value is certain. */
  fold(node: ts.Expression, depth = 0): Result {
    if (depth > MAX_DEPTH) return UNKNOWN;
    const cached = this.cache.get(node);
    if (cached !== undefined) return cached;
    if (this.inProgress.has(node)) return UNKNOWN;
    this.inProgress.add(node);
    let result: Result;
    try {
      result = this.foldInner(node, depth + 1);
    } catch {
      result = UNKNOWN;
    }
    this.inProgress.delete(node);
    this.cache.set(node, result);
    return result;
  }

  foldString(node: ts.Expression): string | Unknown {
    const v = this.fold(node);
    return v === UNKNOWN ? UNKNOWN : toStr(v);
  }

  /** Concatenation of a `let`/`var` initializer and all its `+=` (loose, for address detection only). */
  accumulatedStrings(): string[] {
    const out: string[] = [];
    for (const b of this.bindings.values()) {
      if (b.appends.length === 0 || !b.init) continue;
      let acc = '';
      for (const e of [b.init, ...b.appends]) {
        const s = this.foldString(e);
        acc += s === UNKNOWN ? '\u0000' : s;
      }
      out.push(acc);
    }
    return out;
  }

  private foldInner(node: ts.Expression, depth: number): Result {
    const n = unwrap(node);
    if (n !== node) return this.fold(n, depth);

    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isNumericLiteral(n)) return Number(n.text.replace(/_/g, ''));
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (n.kind === ts.SyntaxKind.NullKeyword) return null;

    if (ts.isPrefixUnaryExpression(n)) {
      const v = this.fold(n.operand, depth);
      if (typeof v !== 'number') return UNKNOWN;
      if (n.operator === ts.SyntaxKind.MinusToken) return -v;
      if (n.operator === ts.SyntaxKind.PlusToken) return v;
      return UNKNOWN;
    }

    if (ts.isTemplateExpression(n)) {
      let acc = n.head.text;
      for (const span of n.templateSpans) {
        const v = this.fold(span.expression, depth);
        if (v === UNKNOWN) return UNKNOWN;
        const s = toStr(v);
        if (s === UNKNOWN) return UNKNOWN;
        acc += s + span.literal.text;
        if (acc.length > MAX_STRING) return UNKNOWN;
      }
      return acc;
    }

    if (ts.isTaggedTemplateExpression(n)) {
      if (memberChain(n.tag) === 'String.raw') {
        const t = n.template;
        if (ts.isNoSubstitutionTemplateLiteral(t)) return t.rawText ?? t.text;
        let acc = t.head.rawText ?? t.head.text;
        for (const span of t.templateSpans) {
          const s = this.foldString(span.expression);
          if (s === UNKNOWN) return UNKNOWN;
          acc += s + (span.literal.rawText ?? span.literal.text);
        }
        return capped(acc);
      }
      return UNKNOWN;
    }

    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.CommaToken) return this.fold(n.right, depth);
      const l = this.fold(n.left, depth);
      if (op === ts.SyntaxKind.BarBarToken) return l === UNKNOWN ? UNKNOWN : l ? l : this.fold(n.right, depth);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return l === UNKNOWN ? UNKNOWN : l ? this.fold(n.right, depth) : l;
      if (op === ts.SyntaxKind.QuestionQuestionToken) return l === UNKNOWN ? UNKNOWN : l === null ? this.fold(n.right, depth) : l;
      if (op === ts.SyntaxKind.PlusToken) {
        const r = this.fold(n.right, depth);
        if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        const ls = toStr(l);
        const rs = toStr(r);
        if (ls === UNKNOWN || rs === UNKNOWN) return UNKNOWN;
        return capped(ls + rs);
      }
      return UNKNOWN;
    }

    if (ts.isConditionalExpression(n)) {
      const c = this.fold(n.condition, depth);
      if (c === UNKNOWN) return UNKNOWN;
      return c ? this.fold(n.whenTrue, depth) : this.fold(n.whenFalse, depth);
    }

    if (ts.isIdentifier(n)) {
      const b = this.binding(ts.idText(n));
      if (!b || b.kind === 'function' || b.kind === 'var' || !b.init) {
        // `let` without reassignment is as good as `const`; `var` too, but only when it has an initializer.
        if (b && b.kind === 'var' && b.init) return this.fold(b.init, depth);
        return UNKNOWN;
      }
      return this.fold(b.init, depth);
    }

    if (ts.isArrayLiteralExpression(n)) {
      const out: Value[] = [];
      for (const el of n.elements) {
        if (ts.isSpreadElement(el)) {
          const v = this.fold(el.expression, depth);
          if (Array.isArray(v)) out.push(...v);
          else if (typeof v === 'string') out.push(...Array.from(v));
          else return UNKNOWN;
        } else if (ts.isOmittedExpression(el)) {
          out.push(null);
        } else {
          const v = this.fold(el, depth);
          if (v === UNKNOWN) return UNKNOWN;
          out.push(v);
        }
      }
      return out;
    }

    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, Value | Unknown>();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) {
          const key = staticPropertyName(p.name, this);
          if (key === UNKNOWN) return UNKNOWN;
          props.set(key, this.fold(p.initializer, depth));
        } else if (ts.isShorthandPropertyAssignment(p)) {
          props.set(ts.idText(p.name), this.fold(p.name, depth));
        } else if (ts.isSpreadAssignment(p)) {
          const v = this.fold(p.expression, depth);
          if (!isObjectValue(v)) return UNKNOWN;
          for (const [k, val] of v.props) props.set(k, val);
        } else if (p.name) {
          const key = staticPropertyName(p.name, this);
          if (key === UNKNOWN) return UNKNOWN;
          props.set(key, UNKNOWN);
        } else {
          return UNKNOWN;
        }
      }
      return makeObject(props);
    }

    if (ts.isPropertyAccessExpression(n)) {
      const obj = this.fold(n.expression, depth);
      return getMember(obj, ts.idText(n.name));
    }

    if (ts.isElementAccessExpression(n)) {
      const obj = this.fold(n.expression, depth);
      const key = this.fold(n.argumentExpression, depth);
      if (obj === UNKNOWN || key === UNKNOWN) return UNKNOWN;
      const k = toStr(key);
      if (k === UNKNOWN) return UNKNOWN;
      return getMember(obj, k);
    }

    if (ts.isCallExpression(n)) return this.foldCall(n, depth);

    return UNKNOWN;
  }

  private foldArgs(args: readonly ts.Expression[], depth: number): Value[] | Unknown {
    const out: Value[] = [];
    for (const a of args) {
      if (ts.isSpreadElement(a)) {
        const v = this.fold(a.expression, depth);
        if (!Array.isArray(v)) return UNKNOWN;
        out.push(...v);
        continue;
      }
      const v = this.fold(a, depth);
      if (v === UNKNOWN) return UNKNOWN;
      out.push(v);
    }
    return out;
  }

  private foldCall(n: ts.CallExpression, depth: number): Result {
    const callee = unwrap(n.expression);
    const chain = memberChain(callee);

    // Global helpers
    if (chain === 'String.fromCharCode' || chain === 'String.fromCodePoint') {
      const args = this.foldArgs(n.arguments, depth);
      if (args === UNKNOWN) return UNKNOWN;
      const nums = args.flat() as Value[];
      if (!nums.every((x) => typeof x === 'number')) return UNKNOWN;
      return chain === 'String.fromCharCode' ? String.fromCharCode(...(nums as number[])) : String.fromCodePoint(...(nums as number[]));
    }
    if (chain === 'String' && n.arguments.length === 1) {
      const a = n.arguments[0];
      return a ? this.foldString(a) : UNKNOWN;
    }
    if (chain === 'atob' || chain === 'window.atob' || chain === 'globalThis.atob') {
      const s = n.arguments[0] ? this.foldString(n.arguments[0]) : UNKNOWN;
      if (s === UNKNOWN) return UNKNOWN;
      return Buffer.from(s, 'base64').toString('latin1');
    }
    if (chain === 'decodeURIComponent' || chain === 'decodeURI' || chain === 'unescape') {
      const s = n.arguments[0] ? this.foldString(n.arguments[0]) : UNKNOWN;
      if (s === UNKNOWN) return UNKNOWN;
      if (chain === 'unescape') return s.replace(/%u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})/g, (_m, u: string, h: string) => String.fromCharCode(parseInt(u ?? h, 16)));
      return chain === 'decodeURI' ? decodeURI(s) : decodeURIComponent(s);
    }
    if (chain === 'JSON.parse' && n.arguments[0]) {
      const s = this.foldString(n.arguments[0]);
      if (s === UNKNOWN) return UNKNOWN;
      return fromJson(JSON.parse(s) as unknown);
    }

    // Parameterless local function returning a single expression
    if (ts.isIdentifier(callee) && n.arguments.length === 0) {
      const b = this.bindings.get(ts.idText(callee));
      if (b && b.declarations === 1 && !b.reassigned && b.returns) return this.fold(b.returns, depth);
    }

    if (!ts.isPropertyAccessExpression(callee)) return UNKNOWN;
    const method = ts.idText(callee.name);

    // Buffer.from(x, enc).toString(enc2)
    if (method === 'toString') {
      const recv = unwrap(callee.expression);
      if (ts.isCallExpression(recv) && memberChain(recv.expression) === 'Buffer.from') {
        const src = recv.arguments[0] ? this.fold(recv.arguments[0], depth) : UNKNOWN;
        const enc = recv.arguments[1] ? this.foldString(recv.arguments[1]) : 'utf8';
        const out = n.arguments[0] ? this.foldString(n.arguments[0]) : 'utf8';
        if (src === UNKNOWN || enc === UNKNOWN || out === UNKNOWN) return UNKNOWN;
        let buf: Buffer;
        if (typeof src === 'string') buf = Buffer.from(src, enc as BufferEncoding);
        else if (Array.isArray(src) && src.every((x) => typeof x === 'number')) buf = Buffer.from(src as number[]);
        else return UNKNOWN;
        return capped(buf.toString(out as BufferEncoding));
      }
    }
    // new TextDecoder().decode(new Uint8Array([...]))
    if (method === 'decode') {
      const recv = unwrap(callee.expression);
      if (ts.isNewExpression(recv) && memberChain(recv.expression) === 'TextDecoder' && n.arguments[0]) {
        const arg = unwrap(n.arguments[0]);
        const arr = ts.isNewExpression(arg) && arg.arguments?.[0] ? this.fold(arg.arguments[0], depth) : this.fold(arg, depth);
        if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'number')) return UNKNOWN;
        return Buffer.from(arr as number[]).toString('utf8');
      }
    }

    const recv = this.fold(callee.expression, depth);
    if (recv === UNKNOWN) return UNKNOWN;
    // Regex literal arguments (replace/split) are read directly by stringMethod.
    const argNodes = n.arguments.map((a) => (ts.isRegularExpressionLiteral(unwrap(a)) ? ts.factory.createNull() : a));
    const args = this.foldArgs(argNodes, depth);
    if (args === UNKNOWN) return UNKNOWN;

    if (typeof recv === 'string') return stringMethod(recv, method, args, n.arguments);
    if (Array.isArray(recv)) return arrayMethod(recv, method, args);
    return UNKNOWN;
  }

  /**
   * Possible URL prefixes of an expression. Each candidate is either the full
   * value (`complete`) or a known prefix followed by something dynamic.
   */
  urlCandidates(node: ts.Expression, depth = 0): UrlCandidate[] {
    if (depth > MAX_DEPTH) return [{ text: '', complete: false }];
    const n = unwrap(node);
    const chain = memberChain(n);
    if (chain !== null && SELF_ORIGIN_CHAINS.has(chain)) return [{ text: SELF_ORIGIN, complete: true }];
    if (chain !== null && SELF_HREF_CHAINS.has(chain)) return [{ text: `${SELF_ORIGIN}/`, complete: false }];

    const folded = this.fold(n);
    if (folded !== UNKNOWN && (typeof folded === 'string' || typeof folded === 'number')) {
      return [{ text: String(folded), complete: true }];
    }

    if (ts.isTemplateExpression(n)) {
      let acc: UrlCandidate[] = [{ text: n.head.text, complete: true }];
      for (const span of n.templateSpans) {
        const subs = this.urlCandidates(span.expression, depth + 1);
        acc = combine(acc, subs, span.literal.text);
      }
      return acc;
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        return combine(this.urlCandidates(n.left, depth + 1), this.urlCandidates(n.right, depth + 1), '');
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return limit([...this.urlCandidates(n.left, depth + 1), ...this.urlCandidates(n.right, depth + 1)]);
      }
      if (op === ts.SyntaxKind.CommaToken) return this.urlCandidates(n.right, depth + 1);
    }
    if (ts.isConditionalExpression(n)) {
      return limit([...this.urlCandidates(n.whenTrue, depth + 1), ...this.urlCandidates(n.whenFalse, depth + 1)]);
    }
    if (ts.isIdentifier(n)) {
      const b = this.binding(ts.idText(n));
      if (b && b.init && b.kind !== 'function') return this.urlCandidates(b.init, depth + 1);
      return [{ text: '', complete: false }];
    }
    if (ts.isNewExpression(n)) {
      const ctor = memberChain(n.expression);
      const args = n.arguments ?? [];
      if ((ctor === 'Request' || ctor === 'window.Request') && args[0]) return this.urlCandidates(args[0], depth + 1);
      if ((ctor === 'URL' || ctor === 'window.URL') && args[0]) return this.newUrlCandidates(args[0], args[1], depth);
    }
    if (ts.isPropertyAccessExpression(n) && ['href', 'toString'].includes(ts.idText(n.name))) {
      return this.urlCandidates(n.expression, depth + 1);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(unwrap(n.expression))) {
      const callee = unwrap(n.expression) as ts.PropertyAccessExpression;
      if (['toString', 'valueOf'].includes(ts.idText(callee.name)) && n.arguments.length === 0) {
        return this.urlCandidates(callee.expression, depth + 1);
      }
    }
    if (ts.isCallExpression(n) && n.arguments[0] && ['String', 'encodeURI'].includes(memberChain(n.expression) ?? '')) {
      return this.urlCandidates(n.arguments[0], depth + 1);
    }
    return [{ text: '', complete: false }];
  }

  private newUrlCandidates(input: ts.Expression, base: ts.Expression | undefined, depth: number): UrlCandidate[] {
    const inputs = this.urlCandidates(input, depth + 1);
    if (!base) return inputs;
    const bases = this.urlCandidates(base, depth + 1);
    const out: UrlCandidate[] = [];
    for (const i of inputs) {
      if (!isRelativeWithFixedOrigin(i)) {
        out.push(i);
        continue;
      }
      for (const b of bases) {
        if (b.complete) {
          try {
            const origin = new URL(b.text).origin;
            out.push(i.complete ? { text: new URL(i.text, b.text).href, complete: true } : { text: `${origin}/`, complete: false });
          } catch {
            out.push({ text: '', complete: false });
          }
        } else {
          out.push({ text: b.text, complete: false });
        }
      }
    }
    return limit(out);
  }
}

function isRelativeWithFixedOrigin(c: UrlCandidate): boolean {
  // eslint-disable-next-line no-control-regex
  const t = c.text.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return false;
  if (/^[/\\]{2}/.test(t)) return false;
  if (c.complete) return true;
  if (/^[/\\][^/\\]/.test(t)) return true;
  if (t.length === 0 || /^[/\\]$/.test(t) || /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(t)) return false;
  return true;
}

function combine(left: UrlCandidate[], right: UrlCandidate[], suffix: string): UrlCandidate[] {
  const out: UrlCandidate[] = [];
  for (const l of left) {
    if (!l.complete) {
      out.push(l);
      continue;
    }
    for (const r of right) {
      out.push(r.complete ? { text: l.text + r.text + suffix, complete: true } : { text: l.text + r.text, complete: false });
    }
  }
  return limit(out);
}

function limit(c: UrlCandidate[]): UrlCandidate[] {
  if (c.length <= MAX_CANDIDATES) return c;
  // Too many branches: keep the first ones and add an unknown one (fails closed).
  return [...c.slice(0, MAX_CANDIDATES - 1), { text: '', complete: false }];
}

function getMember(obj: Result, key: string): Result {
  if (obj === UNKNOWN) return UNKNOWN;
  if (typeof obj === 'string') {
    if (key === 'length') return obj.length;
    if (/^\d+$/.test(key)) return obj[Number(key)] ?? UNKNOWN;
    return UNKNOWN;
  }
  if (Array.isArray(obj)) {
    if (key === 'length') return obj.length;
    if (/^\d+$/.test(key)) return obj[Number(key)] ?? UNKNOWN;
    return UNKNOWN;
  }
  if (isObjectValue(obj)) return obj.props.get(key) ?? UNKNOWN;
  return UNKNOWN;
}

function num(v: Value | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function regexFrom(node: ts.Expression | undefined): RegExp | null {
  if (!node) return null;
  const n = unwrap(node);
  if (!ts.isRegularExpressionLiteral(n)) return null;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(n.text);
  if (!m) return null;
  try {
    return new RegExp(m[1] ?? '', m[2] ?? '');
  } catch {
    return null;
  }
}

function stringMethod(s: string, method: string, args: Value[], argNodes: readonly ts.Expression[]): Result {
  const a0 = args[0];
  const a1 = args[1];
  switch (method) {
    case 'concat': {
      let acc = s;
      for (const a of args) {
        const t = toStr(a);
        if (t === UNKNOWN) return UNKNOWN;
        acc += t;
      }
      return capped(acc);
    }
    case 'toLowerCase':
    case 'toLocaleLowerCase':
      return s.toLowerCase();
    case 'toUpperCase':
    case 'toLocaleUpperCase':
      return s.toUpperCase();
    case 'trim':
      return s.trim();
    case 'trimStart':
      return s.trimStart();
    case 'trimEnd':
      return s.trimEnd();
    case 'toString':
    case 'valueOf':
    case 'normalize':
      return method === 'normalize' ? s.normalize(typeof a0 === 'string' ? a0 : undefined) : s;
    case 'slice':
      return s.slice(num(a0), num(a1));
    case 'substring':
      return s.substring(num(a0) ?? 0, num(a1));
    case 'substr':
      return s.substr(num(a0) ?? 0, num(a1));
    case 'charAt':
      return s.charAt(num(a0) ?? 0);
    case 'at':
      return s.at(num(a0) ?? 0) ?? UNKNOWN;
    case 'repeat': {
      const c = num(a0) ?? 0;
      if (c < 0 || s.length * c > MAX_STRING) return UNKNOWN;
      return s.repeat(c);
    }
    case 'padStart':
    case 'padEnd': {
      const len = num(a0) ?? 0;
      if (len > MAX_STRING) return UNKNOWN;
      const fill = typeof a1 === 'string' ? a1 : ' ';
      return method === 'padStart' ? s.padStart(len, fill) : s.padEnd(len, fill);
    }
    case 'split': {
      const re = regexFrom(argNodes[0]);
      if (re) return s.split(re);
      if (typeof a0 !== 'string') return UNKNOWN;
      return s.split(a0);
    }
    case 'replace':
    case 'replaceAll': {
      const rep = toStr(a1 ?? '');
      if (rep === UNKNOWN) return UNKNOWN;
      const re = regexFrom(argNodes[0]);
      if (re) {
        if (method === 'replaceAll' && !re.global) return UNKNOWN;
        return capped(s.replace(re, rep));
      }
      if (typeof a0 !== 'string') return UNKNOWN;
      return capped(method === 'replace' ? s.replace(a0, rep) : s.split(a0).join(rep));
    }
    default:
      return UNKNOWN;
  }
}

function arrayMethod(arr: Value[], method: string, args: Value[]): Result {
  switch (method) {
    case 'join': {
      const sep = args[0] === undefined ? ',' : toStr(args[0]);
      if (sep === UNKNOWN) return UNKNOWN;
      const parts: string[] = [];
      for (const e of arr) {
        if (e === null) {
          parts.push('');
          continue;
        }
        const t = toStr(e);
        if (t === UNKNOWN) return UNKNOWN;
        parts.push(t);
      }
      return capped(parts.join(sep));
    }
    case 'reverse':
    case 'toReversed':
      return [...arr].reverse();
    case 'concat': {
      const out = [...arr];
      for (const a of args) {
        if (Array.isArray(a)) out.push(...a);
        else out.push(a);
      }
      return out;
    }
    case 'slice':
      return arr.slice(num(args[0]), num(args[1]));
    case 'flat':
      return arr.flat() as Value[];
    case 'toString':
      return toStr(arr);
    default:
      return UNKNOWN;
  }
}

function fromJson(v: unknown): Result {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const out: Value[] = [];
    for (const e of v) {
      const r = fromJson(e);
      if (r === UNKNOWN) return UNKNOWN;
      out.push(r);
    }
    return out;
  }
  if (typeof v === 'object') {
    const props = new Map<string, Value | Unknown>();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) props.set(k, fromJson(val));
    return makeObject(props);
  }
  return UNKNOWN;
}

function singleReturn(fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration): ts.Expression | undefined {
  if (fn.parameters.length > 0) return undefined;
  const body = fn.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body;
  if (body.statements.length !== 1) return undefined;
  const stmt = body.statements[0];
  return stmt && ts.isReturnStatement(stmt) ? stmt.expression : undefined;
}

export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [ts.idText(name)];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    out.push(...bindingNames(el.name));
  }
  return out;
}

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

export { unwrap, toStr };
