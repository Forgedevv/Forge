/// <reference types="node" />
import { readFileSync } from 'node:fs';
import type { LaunchpadSpec } from '@forge/shared';

/**
 * Prompts of the site-coding agent. The system prompt lives in `builder.md` (rules: allowed zones,
 * locked files, security rules); the task prompt carries the client's brief or modification
 * request, JSON-encoded between `<client_request>` tags so it reads as data, not instructions.
 */

let cachedSystemPrompt: string | undefined;

/** Contents of `builder.md`, read once. */
export function builderSystemPrompt(): string {
  cachedSystemPrompt ??= readFileSync(new URL('./builder.md', import.meta.url), 'utf8').trim();
  return cachedSystemPrompt;
}

/** Longest modification request accepted (the chat sends far less). */
export const MAX_REQUEST_CHARS = 8_000;

/** JSON with `<` escaped, so client text can never close the `client_request` block. */
function encodeClientInput(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function clientBlock(value: unknown): string {
  return `<client_request>\n${encodeClientInput(value)}\n</client_request>`;
}

export interface TaskPromptOptions {
  /**
   * Image URLs the site may display (logo, coin image), already checked against the hosts the
   * scan allows. Others are left out so the agent is not tempted to embed them.
   */
  imageUrls?: { logoUrl?: string; coinImageUrl?: string };
}

/** Task of a new launchpad: design the site from the spec. */
export function createTaskPrompt(spec: LaunchpadSpec, opts: TaskPromptOptions = {}): string {
  const brief: Record<string, unknown> = {
    launchpadName: spec.name,
    tagline: spec.theme.tagline,
    primaryColor: spec.theme.primaryColor,
    accentColor: spec.theme.accentColor,
    darkMode: spec.theme.darkMode,
    designNotes: spec.theme.designNotes,
    launchpadCoin: {
      name: spec.launchpadCoin.name,
      symbol: spec.launchpadCoin.symbol,
      description: spec.launchpadCoin.description,
    },
  };
  if (opts.imageUrls?.logoUrl) brief.logoUrl = opts.imageUrls.logoUrl;
  if (opts.imageUrls?.coinImageUrl) brief.coinImageUrl = opts.imageUrls.coinImageUrl;
  return [
    'Design and build the website of this new launchpad for the client: the whole site, ready',
    'for its first visitors, following the design brief of your instructions.',
    '',
    '`forge.config.json` already holds the name, the slug, the colors, the dark mode setting and',
    'the tagline from the brief. Then:',
    '',
    '1. Read the template thoroughly before writing anything.',
    '2. Pick a concept that fits the brief below: palette, font pairing, layout pattern, hero',
    '   illustration, logo mark and voice. A meme brief and a luxury brief must not share a',
    '   layout.',
    '3. Build it across the site: theme, copy in `src/content/index.ts` (with the launchpad coin',
    '   name, symbol and description from the brief), the logo in `src/components/Logo.tsx`,',
    '   header, footer, the home page, `create-pool`, the token page, `about` and the styling of',
    '   `/creator-fees`. Write the "about" text in `forge.config.json#content.about` if the brief',
    '   gives enough material.',
    '4. Day one: the launchpad has no coins yet. The home page must look complete and alive with',
    '   an empty market, which stays compact.',
    '5. Run the self-check of your instructions, fix what is missing, then reply with your summary.',
    '',
    clientBlock(brief),
  ].join('\n');
}

/**
 * Task of a modification: apply the client's request to the live site, nothing else. The
 * launchpad name and slug come from the client's spec too, so they travel inside the escaped
 * client block with the request, never as instruction text.
 */
export function modifyTaskPrompt(request: string, context: { name: string; slug: string }): string {
  return [
    'Apply the client modification request below to this launchpad site. The site is live:',
    'change only what the request asks for (within the zones you may change) and keep',
    'everything else as it is.',
    '',
    'Read the files involved first. Make the change look native to the existing design: reuse',
    'its theme variables, classes and copy voice. Keep it working from 390 px to 1440 px and in',
    'light and dark mode. Do not redesign, restyle or rewrite anything the request does not ask',
    'for.',
    '',
    clientBlock({
      launchpadName: context.name,
      launchpadSlug: context.slug,
      modificationRequest: request,
    }),
  ].join('\n');
}
