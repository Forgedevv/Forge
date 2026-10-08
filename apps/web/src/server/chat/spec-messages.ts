import { knownFieldLabel } from './spec-draft';

/** One readable sentence from a map of field path -> problem. */
export function fieldErrorsMessage(errors: Record<string, string>): string {
  const parts = Object.entries(errors)
    .slice(0, 5)
    .map(([path, why]) => {
      const label = knownFieldLabel(path);
      // Messages that already start with the label (from validateConfirmedSpec) are kept as is.
      if (!label) return path === '' ? why : `${path}: ${why}`;
      return why.startsWith(label) ? why : `${label} ${why}`;
    });
  return parts.length === 0
    ? 'Invalid launchpad spec.'
    : `Invalid launchpad spec. ${parts.join(' ')}`;
}
