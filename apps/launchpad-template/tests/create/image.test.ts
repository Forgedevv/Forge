import { describe, expect, it } from 'vitest';
import { ImageError, checkImageDataUrl, sniffImageType } from '@/forge/create/image';
import { IMAGE_MAX_BYTES } from '@/forge/create/validation';
import { GIF, HTML, JPEG, PNG, SVG, WEBP, dataUrl } from './images';

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ImageError ? error.status : -1;
  }
  return undefined;
}

describe('sniffImageType', () => {
  it('recognizes PNG, JPEG, WebP and GIF by their magic bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(GIF)).toBe('image/gif');
  });

  it('refuses anything else', () => {
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(Uint8Array.from(Buffer.from('RIFF0000WAVE')))).toBeNull();
  });
});

describe('checkImageDataUrl', () => {
  it('accepts an allowed image whose bytes match the declared type', () => {
    for (const [type, bytes] of [
      ['image/png', PNG],
      ['image/jpeg', JPEG],
      ['image/webp', WEBP],
      ['image/gif', GIF],
    ] as const) {
      const image = checkImageDataUrl(dataUrl(type, bytes));
      expect(image.contentType).toBe(type);
      expect(Array.from(image.bytes)).toEqual(Array.from(bytes));
    }
  });

  it('refuses text/html and SVG, whatever they claim to be (415)', () => {
    expect(statusOf(() => checkImageDataUrl(dataUrl('text/html', HTML)))).toBe(415);
    expect(statusOf(() => checkImageDataUrl(dataUrl('image/svg+xml', SVG)))).toBe(415);
    expect(statusOf(() => checkImageDataUrl(dataUrl('image/png', HTML)))).toBe(415);
    expect(statusOf(() => checkImageDataUrl(dataUrl('image/gif', SVG)))).toBe(415);
  });

  it('refuses an image whose bytes are another allowed type (415)', () => {
    expect(statusOf(() => checkImageDataUrl(dataUrl('image/png', JPEG)))).toBe(415);
  });

  it('refuses more than 2 MB (413)', () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(PNG);
    expect(statusOf(() => checkImageDataUrl(dataUrl('image/png', big)))).toBe(413);
    const max = new Uint8Array(IMAGE_MAX_BYTES);
    max.set(PNG);
    expect(checkImageDataUrl(dataUrl('image/png', max)).bytes.length).toBe(IMAGE_MAX_BYTES);
  });

  it('refuses malformed data URLs and base64 (400)', () => {
    expect(statusOf(() => checkImageDataUrl('https://example.com/a.png'))).toBe(400);
    expect(statusOf(() => checkImageDataUrl('data:image/png;base64,'))).toBe(400);
    expect(statusOf(() => checkImageDataUrl('data:image/png;base64,abc'))).toBe(400);
    expect(statusOf(() => checkImageDataUrl('data:image/png,iVBORw0KGgo='))).toBe(400);
  });
});
