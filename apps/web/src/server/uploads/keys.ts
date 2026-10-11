import { IMAGE_EXTENSIONS, type ImageType } from './contract';

/*
 * Write-once object keys of a launchpad's coin uploads. Both the slug and the mint are validated
 * before they reach a key, so a key can never leave the launchpad's folder.
 */

const SLUG = /^[a-z0-9-]{3,32}$/;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function check(slug: string, mint: string): void {
  if (!SLUG.test(slug)) throw new Error('invalid launchpad slug for an object key');
  if (!MINT.test(mint)) throw new Error('invalid mint for an object key');
}

/** `launchpads/{slug}/images/{mint}.{ext}` */
export function imageKey(slug: string, mint: string, contentType: ImageType): string {
  check(slug, mint);
  return `launchpads/${slug}/images/${mint}.${IMAGE_EXTENSIONS[contentType]}`;
}

/** `launchpads/{slug}/metadata/{mint}.json` */
export function metadataKey(slug: string, mint: string): string {
  check(slug, mint);
  return `launchpads/${slug}/metadata/${mint}.json`;
}
