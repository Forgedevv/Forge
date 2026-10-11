export type SandboxErrorCode =
  /** Options do not parse (programming error of the caller). */
  | 'invalid_options'
  /** Options parse but would weaken the sandbox: refused. */
  | 'unsafe_option'
  /** A docker CLI call failed. */
  | 'docker_failed'
  /** The egress proxy could not be set up. */
  | 'egress_failed';

/** Error raised by the sandbox runner. Messages never contain secret values. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}
