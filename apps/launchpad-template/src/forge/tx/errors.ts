/**
 * LOCKED ZONE. Error thrown whenever a transaction or a server answer does not match what the user
 * is shown. Callers map it to a user-facing message; nothing is ever signed after one is thrown.
 */
export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}
