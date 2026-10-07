/// <reference types="node" />

/**
 * Types of the blocking security scan (docs/SECURITY.md section 1).
 *
 * The builder computes the list of changed files between the template baseline
 * (what FORGE wrote) and the agent's result, then calls `scanDiff`. Any
 * violation blocks the push.
 */

/** Git file mode. Only `100644` (regular, non-executable file) is accepted. */
export type GitMode = '100644' | '100755' | '120000' | '160000' | (string & {});

/** File content. Prefer bytes (Buffer / Uint8Array): binary files MUST be given as bytes. */
export type FileContent = string | Uint8Array;

export interface ChangedFile {
  /** Repo-relative POSIX path (new path for a rename). */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Previous path, required when `status === 'renamed'`. */
  oldPath?: string;
  /** Baseline content; `null` for an added file. */
  oldContent: FileContent | null;
  /** Agent's content; `null` for a deleted file. */
  newContent: FileContent | null;
  /** Git mode of the new file (ignored for deleted files). Missing = `100644`. */
  mode?: GitMode;
  /** Git mode of the baseline file, if known. */
  oldMode?: GitMode;
}

export interface ScanInput {
  files: ChangedFile[];
}

export type RuleId =
  // Paths and file structure
  | 'path-invalid'
  | 'forge-locked-zone'
  | 'next-config'
  | 'zone-outside-allowed'
  | 'api-route'
  | 'special-file'
  | 'file-type-not-allowed'
  | 'file-mode'
  | 'binary-file'
  | 'file-too-large'
  | 'encoding-invalid'
  | 'node-modules'
  | 'patch-package'
  // Manifests and config
  | 'forge-config-locked-field'
  | 'forge-config-invalid'
  | 'forge-config-unsafe-value'
  | 'forge-core-dependency'
  | 'lockfile-forge-core'
  // Content
  | 'parse-error'
  | 'solana-address'
  | 'solana-address-encoded'
  | 'external-script'
  | 'inline-script'
  | 'network-domain'
  | 'network-dynamic-url'
  | 'network-api-forbidden'
  | 'navigation-external'
  | 'embed-external'
  | 'wallet-api'
  | 'forbidden-import'
  | 'dynamic-code'
  | 'dangerous-html'
  | 'javascript-url'
  | 'global-access'
  | 'server-secret'
  | 'server-response'
  | 'html-active-content'
  | 'hidden-unicode';

export interface Violation {
  rule: RuleId;
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line in the new content, or `null` for a file-level violation. */
  line: number | null;
  /** Short human-readable reason. */
  reason: string;
}

export type ScanResult = { ok: true } | { ok: false; violations: Violation[] };

export interface ScanOptions {
  /**
   * Hosts that client-side code may contact (fetch, WebSocket, script src...).
   * `example.com` matches exactly; `*.example.com` matches strict subdomains only.
   * Replaces the default list when given.
   */
  allowedHosts?: readonly string[];
  /** Extra hosts added to `allowedHosts` (e.g. the RPC relay host, the R2 public host). */
  extraAllowedHosts?: readonly string[];
  /** Host of the RPC relay (apps/web), added to the allowed hosts. */
  rpcRelayHost?: string;
  /** Public host of the R2 bucket, added to the allowed hosts. Never use a `*.r2.dev` wildcard. */
  r2PublicHost?: string;
  /** Hosts allowed as navigation targets only (window.open, redirects). Replaces the default list. */
  linkHosts?: readonly string[];
  /** Exact base58 values that may be added (empty by default). */
  addressAllowlist?: readonly string[];
  /** Maximum size of a text file, in bytes. */
  maxTextBytes?: number;
  /** Maximum size of a binary file (image, font), in bytes. */
  maxBinaryBytes?: number;
}

/** A finding produced by content analysis, before diffing against the baseline. */
export interface Finding {
  rule: RuleId;
  /** Stable identity used to compare baseline vs new content (must not contain the line). */
  key: string;
  line: number;
  reason: string;
}
