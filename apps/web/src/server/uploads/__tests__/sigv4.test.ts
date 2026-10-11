// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { amzDate, deriveSigningKey, presign, presignParts, uriEncode } from '../sigv4';

/*
 * Vectors 1 and 2 are the published AWS examples ("Examples of how to derive a signing key for
 * Signature Version 4" and the presigned GET example of "Authenticating Requests: Using Query
 * Parameters" in the S3 API reference). Vector 3 (a ticket PUT with the three signed headers) was
 * computed independently with the AWS SDK v3 signer.
 */

describe('SigV4 signing key', () => {
  it('matches the AWS signing key derivation example', () => {
    const key = deriveSigningKey(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      '20120215',
      'us-east-1',
      'iam',
    );
    expect(key.toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });
});

describe('SigV4 query presign', () => {
  const awsExample = {
    method: 'GET' as const,
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    region: 'us-east-1',
    service: 's3',
    credentials: {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    date: new Date('2013-05-24T00:00:00Z'),
    expiresSeconds: 86400,
  };

  it('matches the AWS presigned GET example step by step', () => {
    const parts = presignParts(awsExample);
    expect(parts.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        'host:examplebucket.s3.amazonaws.com',
        '',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    );
    expect(parts.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20130524T000000Z',
        '20130524/us-east-1/s3/aws4_request',
        '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04',
      ].join('\n'),
    );
    expect(parts.signature).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(presign(awsExample).url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('signs the write-once PUT headers of an upload ticket (sorted, lowercased)', () => {
    const input = {
      method: 'PUT' as const,
      url: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/forge-dev/launchpads/moonpad/images/So11111111111111111111111111111111111111112.png',
      region: 'auto',
      service: 's3',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      date: new Date('2026-10-11T12:00:00.000Z'),
      expiresSeconds: 600,
      headers: {
        'Content-Type': 'image/png',
        'If-None-Match': '*',
        'x-amz-checksum-sha256': 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
      },
    };
    const parts = presignParts(input);
    expect(parts.signedHeaders).toBe('content-type;host;if-none-match;x-amz-checksum-sha256');
    expect(parts.canonicalRequest.split('\n').slice(3, 8)).toEqual([
      'content-type:image/png',
      'host:0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      'if-none-match:*',
      'x-amz-checksum-sha256:n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
      '',
    ]);
    // Cross-checked with the AWS SDK v3 signer (@smithy/signature-v4 5.7.4, unsigned payload).
    expect(parts.signature).toBe(
      '458dd5e93a24bd86d23cff57fae19332a7041e2d815cae6cb55d9197f910c439',
    );
    const signed = presign(input);
    expect(signed.headers).toEqual(input.headers);
    const url = new URL(signed.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261011T120000Z');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20261011/auto/s3/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Signature')).toBe(parts.signature);
    // Deterministic: the same inputs give the same URL.
    expect(presign(input).url).toBe(signed.url);
  });

  it('refuses non-https URLs, query strings, bad expiries and duplicate headers', () => {
    expect(() => presignParts({ ...awsExample, url: 'http://example.com/a' })).toThrow();
    expect(() => presignParts({ ...awsExample, url: 'https://example.com/a?x=1' })).toThrow();
    expect(() => presignParts({ ...awsExample, expiresSeconds: 0 })).toThrow();
    expect(() => presignParts({ ...awsExample, expiresSeconds: 604801 })).toThrow();
    expect(() => presignParts({ ...awsExample, headers: { Host: 'x' } })).toThrow();
    expect(() =>
      presignParts({ ...awsExample, headers: { 'Content-Type': 'a', 'content-type': 'b' } }),
    ).toThrow();
  });

  it('encodes per RFC 3986 and formats dates', () => {
    expect(uriEncode('a b/c~d*e')).toBe('a%20b%2Fc~d%2Ae');
    expect(uriEncode('a b/c', true)).toBe('a%20b/c');
    expect(uriEncode('é')).toBe('%C3%A9');
    expect(amzDate(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });
});
