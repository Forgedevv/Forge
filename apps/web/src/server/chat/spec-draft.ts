import {
  CLIENT_BOUNDS,
  LaunchpadSpec,
  validateSpecDraft,
  type LaunchpadSpecDraft,
  type SpecValidation,
} from '@forge/shared';
import { z } from 'zod';

/*
 * Server-side handling of the spec the model fills in through the `update_spec` tool.
 *
 * The model proposes a patch; this module is the only place where a patch becomes part of the
 * draft. Every field is checked on its own against the LaunchpadSpec field schema (so one bad
 * field never blocks the good ones), then against extra rules the schema cannot express
 * (https-only public image URLs, no wallet addresses or links in free text, reserved slugs).
 * `ownerWallet`, `version` and `quote` are never taken from the model.
 */

export type SpecMode = 'create' | 'modify';

const shape = LaunchpadSpec.shape;
const themeShape = shape.theme.shape;
const coinShape = shape.launchpadCoin.shape;

type Group = 'identity' | 'onchain' | 'theme' | 'coin';

interface Leaf {
  /** Dotted path, e.g. "theme.primaryColor". */
  path: string;
  group: Group;
  /** Name shown to the user. */
  label: string;
  /** Field schema without defaults, used for validation and to derive the tool schema. */
  schema: z.ZodType;
  /** Human sentence used when the value is rejected. */
  hint: string;
  kind?: 'text' | 'url' | 'slug' | 'symbol' | 'color';
}

const { tradingFeeBps, coinCreatorSharePct, poolCreationFeeSol } = CLIENT_BOUNDS;

const LEAVES: readonly Leaf[] = [
  {
    path: 'name',
    group: 'identity',
    label: 'Launchpad name',
    schema: shape.name.describe('Launchpad display name, 2 to 32 characters.'),
    hint: 'must be 2 to 32 characters.',
    kind: 'text',
  },
  {
    path: 'slug',
    group: 'identity',
    label: 'Subdomain',
    schema: shape.slug.describe(
      'Subdomain of the launchpad: 3 to 32 characters, lowercase letters, digits and dashes.',
    ),
    hint: 'must be 3 to 32 characters: lowercase letters, digits and dashes.',
    kind: 'slug',
  },
  {
    path: 'tradingFeeBps',
    group: 'onchain',
    label: 'Trading fee',
    schema: shape.tradingFeeBps.describe(
      `Trading fee in basis points (100 = 1%). Whole number from ${tradingFeeBps.min} to ${tradingFeeBps.max}.`,
    ),
    hint: `must be a whole number of basis points between ${tradingFeeBps.min} and ${tradingFeeBps.max} (${tradingFeeBps.min / 100}% to ${tradingFeeBps.max / 100}%).`,
  },
  {
    path: 'coinCreatorSharePct',
    group: 'onchain',
    label: 'Coin creator share',
    schema: shape.coinCreatorSharePct.def.innerType.describe(
      `Percentage of trading fees paid to the coin creator, whole number from ${coinCreatorSharePct.min} to ${coinCreatorSharePct.max}.`,
    ),
    hint: `must be a whole number between ${coinCreatorSharePct.min} and ${coinCreatorSharePct.max}.`,
  },
  {
    path: 'poolCreationFeeSol',
    group: 'onchain',
    label: 'Coin creation fee',
    schema: shape.poolCreationFeeSol.describe(
      `Fee in SOL paid by whoever launches a coin on this launchpad: 0 (no fee) or between ${poolCreationFeeSol.min} and ${poolCreationFeeSol.max}.`,
    ),
    hint: `must be 0 (no fee) or between ${poolCreationFeeSol.min} and ${poolCreationFeeSol.max} SOL.`,
  },
  {
    path: 'antiSniper',
    group: 'onchain',
    label: 'Anti-sniper protection',
    schema: shape.antiSniper.def.innerType.describe(
      'Whether the anti-sniper fee schedule is enabled on new coins.',
    ),
    hint: 'must be true or false.',
  },
  {
    path: 'theme.primaryColor',
    group: 'theme',
    label: 'Primary color',
    schema: themeShape.primaryColor.describe('Primary color as a 6-digit hex value, e.g. #7C3AED.'),
    hint: 'must be a 6-digit hex color like #7C3AED.',
    kind: 'color',
  },
  {
    path: 'theme.accentColor',
    group: 'theme',
    label: 'Accent color',
    schema: themeShape.accentColor.describe('Accent color as a 6-digit hex value, e.g. #F59E0B.'),
    hint: 'must be a 6-digit hex color like #F59E0B.',
    kind: 'color',
  },
  {
    path: 'theme.darkMode',
    group: 'theme',
    label: 'Dark mode',
    schema: themeShape.darkMode.describe('true for a dark theme, false for a light theme.'),
    hint: 'must be true or false.',
  },
  {
    path: 'theme.tagline',
    group: 'theme',
    label: 'Tagline',
    schema: themeShape.tagline.describe('Short tagline, at most 120 characters.'),
    hint: 'must be at most 120 characters.',
    kind: 'text',
  },
  {
    path: 'theme.logoUrl',
    group: 'theme',
    label: 'Logo URL',
    schema: themeShape.logoUrl.unwrap().describe('Public https URL of the logo (optional).'),
    hint: 'must be a public https URL.',
    kind: 'url',
  },
  {
    path: 'theme.designNotes',
    group: 'theme',
    label: 'Design notes',
    schema: themeShape.designNotes.describe(
      'Visual design instructions for the site builder (layout, mood, fonts, imagery). Max 2000 characters. Visual design only.',
    ),
    hint: 'must be at most 2000 characters and describe the visual design only.',
    kind: 'text',
  },
  {
    path: 'launchpadCoin.name',
    group: 'coin',
    label: 'Launchpad coin name',
    schema: coinShape.name.describe('Name of the launchpad coin, 1 to 32 characters.'),
    hint: 'must be 1 to 32 characters.',
    kind: 'text',
  },
  {
    path: 'launchpadCoin.symbol',
    group: 'coin',
    label: 'Launchpad coin symbol',
    schema: coinShape.symbol.describe('Ticker: 2 to 10 uppercase letters or digits.'),
    hint: 'must be 2 to 10 uppercase letters or digits.',
    kind: 'symbol',
  },
  {
    path: 'launchpadCoin.description',
    group: 'coin',
    label: 'Launchpad coin description',
    schema: coinShape.description.describe('Coin description, at most 500 characters.'),
    hint: 'must be at most 500 characters.',
    kind: 'text',
  },
  {
    path: 'launchpadCoin.imageUrl',
    group: 'coin',
    label: 'Launchpad coin image URL',
    schema: coinShape.imageUrl.describe('Public https URL of the coin image.'),
    hint: 'must be a public https URL.',
    kind: 'url',
  },
  {
    path: 'launchpadCoin.firstBuySol',
    group: 'coin',
    label: 'First buy',
    schema: coinShape.firstBuySol.describe(
      'SOL the client spends to buy the launchpad coin at launch, from 0 to 100.',
    ),
    hint: 'must be a number of SOL between 0 and 100.',
  },
];

const LEAF_BY_PATH = new Map(LEAVES.map((l) => [l.path, l]));

const SERVER_FIELD_HINTS: Record<string, string> = {
  ownerWallet: 'must be a valid Solana address.',
  version: 'must be 1.',
  quote: 'must be SOL.',
};

const SERVER_FIELD_LABELS: Record<string, string> = {
  ownerWallet: 'Owner wallet',
  version: 'Spec version',
  quote: 'Quote currency',
};

/** Name of a spec field as shown to the user, or undefined for an unknown path. */
export function knownFieldLabel(path: string): string | undefined {
  return LEAF_BY_PATH.get(path)?.label ?? SERVER_FIELD_LABELS[path];
}

// ---------------------------------------------------------------------------
// Extra rules
// ---------------------------------------------------------------------------

const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const MARKUP = /<\s*\/?\s*[a-z!]|javascript:|data:text\/html/i;
const CONTROL_CHARS = /[^\P{Cc}\n\t]|[\p{Zl}\p{Zp}]/u;
const FORBIDDEN_INSTRUCTIONS: readonly RegExp[] = [
  /\b(private key|secret key|seed phrase|mnemonic|keypair)\b/i,
  /\bignore\b[^.]{0,30}\b(instructions|rules|prompt)\b/i,
  /\b(system prompt|developer message)\b/i,
  /\b(setAuthority|createApproveInstruction|signAllTransactions|dangerouslySetInnerHTML)\b/,
  /\beval\s*\(/i,
  /\b(src\/forge|forge\.config|@forge\/core)\b/i,
  /\b(fee|platform|referral|treasury|multisig)\s+(wallet|address|account|recipient)\b/i,
];

const RESERVED_SLUGS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'dashboard',
  'forge',
  'mail',
  'email',
  'ftp',
  'static',
  'assets',
  'cdn',
  'docs',
  'help',
  'support',
  'status',
  'blog',
  'login',
  'auth',
  'staging',
  'preview',
  'test',
  'dev',
  'root',
  'solana',
  'meteora',
  'jupiter',
]);

function checkFreeText(value: string): string | null {
  if (CONTROL_CHARS.test(value)) return 'contains unsupported control characters.';
  if (BASE58_ADDRESS.test(value)) return 'must not contain wallet addresses or long keys.';
  if (MARKUP.test(value)) return 'must be plain text, without HTML or scripts.';
  if (LINK.test(value)) return 'must not contain links: use the dedicated image fields.';
  if (FORBIDDEN_INSTRUCTIONS.some((re) => re.test(value))) {
    return 'can only describe the visual design and the project, not technical or wallet instructions.';
  }
  return null;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
}

function checkPublicHttpsUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be a valid URL.';
  }
  if (url.protocol !== 'https:') return 'must use https.';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials.';
  if (url.port !== '') return 'must use the default https port.';
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    isIpLiteral(host) ||
    !host.includes('.') ||
    /\.(local|localhost|internal|lan|home|corp)$/.test(host)
  ) {
    return 'must point to a public website.';
  }
  return null;
}

function semanticProblem(leaf: Leaf, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  switch (leaf.kind) {
    case 'text':
      return checkFreeText(value);
    case 'url':
      return checkPublicHttpsUrl(value);
    case 'slug':
      return RESERVED_SLUGS.has(value) ? 'is reserved, pick another one.' : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Draft state
// ---------------------------------------------------------------------------

/** Draft of a new conversation: server-controlled fields plus the documented defaults. */
export function initialDraft(ownerWallet: string): LaunchpadSpecDraft {
  return {
    version: 1,
    quote: 'SOL',
    ownerWallet,
    coinCreatorSharePct: CLIENT_BOUNDS.coinCreatorSharePct.default,
    antiSniper: true,
  };
}

/** Forces the fields the model and the stored state must never control. */
export function normalizeDraft(draft: LaunchpadSpecDraft, ownerWallet: string): LaunchpadSpecDraft {
  return { ...draft, version: 1, quote: 'SOL', ownerWallet };
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      cur[part] = created;
      cur = created;
    }
  }
  const last = parts[parts.length - 1];
  if (last === undefined) return;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

const SERVER_FIELDS = new Set(['ownerWallet', 'version', 'quote']);
const NESTED = new Set(['theme', 'launchpadCoin']);

export interface PatchResult {
  draft: LaunchpadSpecDraft;
  /** Dotted paths that were applied. */
  applied: string[];
  /** Dotted path -> sentence explaining why the value was rejected. */
  rejected: Record<string, string>;
}

/** Flattens a patch to leaf entries; anything that is not a known field is reported. */
function flattenPatch(
  patch: Record<string, unknown>,
  rejected: Record<string, string>,
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (SERVER_FIELDS.has(key)) {
      rejected[key] = 'is set by FORGE and cannot be changed in the chat.';
    } else if (NESTED.has(key)) {
      if (!isPlainObject(value)) {
        rejected[key] = 'must be an object of fields.';
        continue;
      }
      for (const sub of Object.keys(value)) {
        const path = `${key}.${sub}`;
        if (LEAF_BY_PATH.has(path)) entries.push([path, value[sub]]);
        else rejected[path] = 'is not a field of the launchpad spec.';
      }
    } else if (LEAF_BY_PATH.has(key)) {
      entries.push([key, value]);
    } else {
      rejected[key] = 'is not a field of the launchpad spec.';
    }
  }
  return entries;
}

/**
 * Applies a model-proposed patch to the draft. Never throws: invalid fields end up in
 * `rejected` and the rest of the patch is still applied.
 */
export function applySpecPatch(
  current: LaunchpadSpecDraft,
  patch: unknown,
  opts: { ownerWallet: string; mode: SpecMode },
): PatchResult {
  // Null prototype: a model-chosen key such as "__proto__" is recorded like any other.
  const rejected = Object.create(null) as Record<string, string>;
  const applied: string[] = [];
  const next = structuredClone(current) as Record<string, unknown>;

  if (!isPlainObject(patch)) {
    return {
      draft: normalizeDraft(current, opts.ownerWallet),
      applied,
      rejected: { spec: 'the update must be an object of fields.' },
    };
  }

  for (const [path, rawValue] of flattenPatch(patch, rejected)) {
    const leaf = LEAF_BY_PATH.get(path);
    if (!leaf) continue;
    if (opts.mode === 'modify' && leaf.group !== 'theme') {
      rejected[path] = 'cannot be changed after launch: only the design can be modified.';
      continue;
    }
    // null clears an optional field.
    if (rawValue === null && path === 'theme.logoUrl') {
      setPath(next, path, undefined);
      applied.push(path);
      continue;
    }
    const value =
      leaf.kind === 'symbol' && typeof rawValue === 'string' ? rawValue.toUpperCase() : rawValue;
    const parsed = leaf.schema.safeParse(value);
    if (!parsed.success) {
      rejected[path] = leaf.hint;
      continue;
    }
    const problem = semanticProblem(leaf, parsed.data);
    if (problem !== null) {
      rejected[path] = problem;
      continue;
    }
    setPath(next, path, parsed.data);
    applied.push(path);
  }

  return {
    draft: normalizeDraft(next as LaunchpadSpecDraft, opts.ownerWallet),
    applied,
    rejected,
  };
}

/** Validation of a draft, including the extra rules, in the shape the stream event expects. */
export function validateDraft(draft: LaunchpadSpecDraft): SpecValidation {
  const base = validateSpecDraft(draft);
  const errors = { ...base.errors };
  for (const leaf of LEAVES) {
    if (leaf.path in errors) continue;
    const problem = semanticProblem(leaf, getPath(draft, leaf.path));
    if (problem !== null) errors[leaf.path] = `${leaf.label} ${problem}`;
  }
  return { complete: Object.keys(errors).length === 0, errors };
}

export type ConfirmedSpecResult =
  { ok: true; spec: LaunchpadSpec } | { ok: false; errors: Record<string, string> };

/** Full validation of a spec submitted for confirmation: schema, bounds and extra rules. */
export function validateConfirmedSpec(input: unknown): ConfirmedSpecResult {
  const parsed = LaunchpadSpec.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join('.');
      if (!(key in errors))
        errors[key] = LEAF_BY_PATH.get(key)?.hint ?? SERVER_FIELD_HINTS[key] ?? issue.message;
    }
    return { ok: false, errors };
  }
  const errors: Record<string, string> = {};
  for (const leaf of LEAVES) {
    const problem = semanticProblem(leaf, getPath(parsed.data, leaf.path));
    if (problem !== null) errors[leaf.path] = `${leaf.label} ${problem}`;
  }
  return Object.keys(errors).length === 0 ? { ok: true, spec: parsed.data } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const UPDATE_SPEC_TOOL_NAME = 'update_spec';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function objectOf(groupLeaves: readonly Leaf[], strip: string): z.ZodObject {
  const fields: Record<string, z.ZodType> = {};
  for (const leaf of groupLeaves) {
    fields[leaf.path.slice(strip.length)] = leaf.schema.optional();
  }
  return z.strictObject(fields);
}

/**
 * Tool schema for the model, derived from the LaunchpadSpec field schemas (all fields optional:
 * the model sends only what changed). `ownerWallet`, `version` and `quote` are not offered.
 */
export function buildUpdateSpecTool(mode: SpecMode): ToolDefinition {
  const topFields: Record<string, z.ZodType> = {};
  if (mode === 'create') {
    for (const leaf of LEAVES.filter((l) => !l.path.includes('.'))) {
      topFields[leaf.path] = leaf.schema.optional();
    }
  }
  const themeObj = objectOf(
    LEAVES.filter((l) => l.group === 'theme'),
    'theme.',
  );
  const coinObj = objectOf(
    LEAVES.filter((l) => l.group === 'coin'),
    'launchpadCoin.',
  );
  const fields: Record<string, z.ZodType> = {
    ...topFields,
    theme: themeObj.optional().describe('Design settings.'),
  };
  if (mode === 'create') fields.launchpadCoin = coinObj.optional().describe('The launchpad coin.');
  const doc = z.strictObject(fields);
  const jsonSchema = z.toJSONSchema(doc, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete jsonSchema.$schema;
  return {
    name: UPDATE_SPEC_TOOL_NAME,
    description:
      'Record launchpad settings the client has clearly stated or agreed to. Send only the fields ' +
      'that changed. Values are validated by the server: rejected fields are listed in the result ' +
      'and must be re-asked from the client. Never invent values the client did not give or accept.',
    input_schema: jsonSchema,
  };
}

/** Compact, stable JSON of a draft (used to detect changes). */
export function draftKey(draft: LaunchpadSpecDraft): string {
  return JSON.stringify(draft, (_k, v: unknown) => {
    if (isPlainObject(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

/** Paths still missing or invalid, in the order of the spec. */
export function missingFields(validation: SpecValidation): string[] {
  return Object.keys(validation.errors);
}
