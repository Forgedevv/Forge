import type { ImageField } from './rehost';

/*
 * The owner's image URLs a launchpad was confirmed from (`launchpads.image_sources`, migration
 * 0014), by spec field: `{ "launchpadCoin.imageUrl": "<owner URL>", "theme.logoUrl": ... }`.
 * Only the fields whose URL was replaced by a bucket copy are kept. Written by the server at
 * confirmation (chat/store.ts), never sent to the builder or the client site.
 *
 * They let the server recognise the owner's original URL afterwards without downloading it again:
 * a confirmation retried with the same spec (chat/spec-confirm.ts) and a creation conversation
 * whose draft still holds the original URL (launchpads/modification-images.ts).
 */

export type ImageSources = Partial<Record<ImageField, string>>;

/** The image fields of a spec, the coin image first (its failure is reported first). */
export const IMAGE_FIELDS: readonly ImageField[] = ['launchpadCoin.imageUrl', 'theme.logoUrl'];

/** An image of a confirmed spec: the owner's URL and the bucket URL that replaced it. */
export interface CopiedImage {
  field: ImageField;
  source: string;
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The non-empty string at `field` of a stored spec or draft (both unparsed jsonb). */
export function readImageUrl(spec: unknown, field: ImageField): string | undefined {
  const [group, key] = field.split('.') as [string, string];
  if (!isRecord(spec)) return undefined;
  const section = spec[group];
  if (!isRecord(section)) return undefined;
  const value = section[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A copy of `spec` with the image URLs of `urls` set (sections that are not objects are left). */
export function withImageUrls<T>(spec: T, urls: ImageSources): T {
  if (!isRecord(spec)) return spec;
  const out: Record<string, unknown> = { ...spec };
  for (const field of IMAGE_FIELDS) {
    const url = urls[field];
    if (url === undefined) continue;
    const [group, key] = field.split('.') as [string, string];
    const section = out[group];
    if (isRecord(section)) out[group] = { ...section, [key]: url };
  }
  return out as T;
}

/** The images `rehosted` copied from `original` (fields whose URL changed). */
export function copiedImages(original: unknown, rehosted: unknown): CopiedImage[] {
  return IMAGE_FIELDS.flatMap((field) => {
    const source = readImageUrl(original, field);
    const url = readImageUrl(rehosted, field);
    return source !== undefined && url !== undefined && source !== url
      ? [{ field, source, url }]
      : [];
  });
}

/** The sources to record for these copies. */
export function sourcesOf(images: readonly CopiedImage[]): ImageSources {
  const sources: ImageSources = {};
  for (const image of images) sources[image.field] = image.source;
  return sources;
}

/** Stored sources (unparsed jsonb): known fields with a non-empty string only, else nothing. */
export function parseImageSources(value: unknown): ImageSources {
  const sources: ImageSources = {};
  if (!isRecord(value)) return sources;
  for (const field of IMAGE_FIELDS) {
    const source = value[field];
    if (typeof source === 'string' && source.length > 0) sources[field] = source;
  }
  return sources;
}

/**
 * `spec` with each image URL that is the recorded source of `confirmed`'s image replaced by the
 * bucket URL of `confirmed`: what the spec was once its images were copied.
 */
export function asConfirmedImages<T>(spec: T, confirmed: unknown, sources: ImageSources): T {
  const urls: ImageSources = {};
  for (const field of IMAGE_FIELDS) {
    const source = sources[field];
    const url = readImageUrl(confirmed, field);
    if (source !== undefined && url !== undefined && readImageUrl(spec, field) === source) {
      urls[field] = url;
    }
  }
  return withImageUrls(spec, urls);
}
