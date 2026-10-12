/**
 * Minimal PNG check for screenshots that come out of the review container (untrusted bytes).
 * Nothing is decoded: the chunk structure is walked, every CRC checked, and the image is rebuilt
 * from its critical chunks only (IHDR, PLTE, IDAT, IEND), so no ancillary chunk (text, metadata,
 * profiles) written by the container is passed on.
 */

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 16_384;
const MAX_CHUNKS = 100_000;

let crcTable: Uint32Array | undefined;

/** CRC-32 (ISO 3309), as used by PNG chunks. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface SanitizedPng {
  png: Buffer;
  width: number;
  height: number;
}

/** Validates a PNG and returns it rebuilt from its critical chunks. Throws `PngError`. */
export function sanitizePng(buf: Buffer): SanitizedPng {
  if (buf.length < SIGNATURE.length + 25 + 12 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('not a PNG file');
  }
  const kept: Buffer[] = [SIGNATURE];
  let offset = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let chunks = 0;
  while (offset < buf.length) {
    if (offset + 12 > buf.length) throw new PngError('truncated chunk');
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('invalid chunk type');
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > buf.length) throw new PngError('chunk runs past the file');
    const crc = buf.readUInt32BE(offset + 8 + length);
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== crc) {
      throw new PngError(`bad CRC in a ${type} chunk`);
    }
    chunks += 1;
    if (chunks > MAX_CHUNKS) throw new PngError('too many chunks');
    const chunk = buf.subarray(offset, end);
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new PngError('IHDR must come first');
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
      const bitDepth = buf[offset + 16]!;
      const colorType = buf[offset + 17]!;
      const compression = buf[offset + 18]!;
      const filter = buf[offset + 19]!;
      const interlace = buf[offset + 20]!;
      if (
        ![1, 2, 4, 8, 16].includes(bitDepth) ||
        ![0, 2, 3, 4, 6].includes(colorType) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace > 1
      ) {
        throw new PngError('unsupported IHDR');
      }
      sawHeader = true;
      kept.push(chunk);
    } else if (type === 'IHDR') {
      throw new PngError('duplicate IHDR');
    } else if (type === 'PLTE') {
      if (sawData) throw new PngError('PLTE after IDAT');
      kept.push(chunk);
    } else if (type === 'IDAT') {
      sawData = true;
      kept.push(chunk);
    } else if (type === 'IEND') {
      if (length !== 0) throw new PngError('invalid IEND');
      kept.push(chunk);
      sawEnd = true;
      offset = end;
      break;
    } else if (type[0]! >= 'A' && type[0]! <= 'Z') {
      throw new PngError(`unknown critical chunk ${type}`);
    }
    // Ancillary chunks (lowercase first letter) are dropped.
    offset = end;
  }
  if (!sawEnd || !sawData) throw new PngError('missing IDAT or IEND');
  if (offset !== buf.length) throw new PngError('data after IEND');
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new PngError('invalid dimensions');
  }
  return { png: Buffer.concat(kept), width, height };
}
