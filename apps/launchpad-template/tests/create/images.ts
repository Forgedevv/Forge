/** Minimal byte prefixes of each image format (enough for magic-byte detection). */
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
export const GIF = Uint8Array.from(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'));
export const WEBP = Uint8Array.from(
  Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
);
export const HTML = Uint8Array.from(Buffer.from('<html><script>alert(1)</script></html>'));
export const SVG = Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

export function dataUrl(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}
