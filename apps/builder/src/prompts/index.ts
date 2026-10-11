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
    'Design this new launchpad site for the client.',
    '',
    '`forge.config.json` already holds the name, the slug, the colors, the dark mode setting and',
    'the tagline from the brief. Give the site a distinctive look that matches the brief: theme,',
    'typography, home page layout, hero section and copy. Write the "about" text in',
    '`forge.config.json#content.about` if the brief gives enough material.',
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
    clientBlock({
      launchpadName: context.name,
      launchpadSlug: context.slug,
      modificationRequest: request,
    }),
  ].join('\n');
}
