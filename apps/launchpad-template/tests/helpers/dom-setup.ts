import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';

// Imported for its side effects by the jsdom component tests.

// jsdom swaps the global Uint8Array for its own realm, which breaks `Buffer instanceof Uint8Array`
// checks inside @solana/web3.js. Restore Node's Uint8Array (the prototype of Buffer).
globalThis.Uint8Array = Object.getPrototypeOf(Buffer) as Uint8ArrayConstructor;

afterEach(() => {
  cleanup();
});
