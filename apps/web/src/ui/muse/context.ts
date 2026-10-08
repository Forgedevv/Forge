import type { JobStatus, LaunchpadSpecDraft } from '@forge/shared';
import type { MuseMood } from './moods';
import { isHexColor } from './paint';

/** The Muse's mood for each step of a job. */
export function museMoodForJob(status: JobStatus): MuseMood {
  switch (status) {
    case 'paid':
    case 'building':
    case 'approved':
    case 'onchain_setup':
    case 'owner_signed':
    case 'deploying':
      return 'building';
    case 'preview_ready':
    case 'awaiting_owner_signature':
      return 'waiting_approval';
    case 'live':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}

/** A launchpad's own Muse colors, from its theme; `null` falls back to FORGE colors. */
export function museColorsFor(spec: LaunchpadSpecDraft | null | undefined): {
  primary: string | null;
  accent: string | null;
} {
  const theme = spec?.theme;
  return {
    primary: isHexColor(theme?.primaryColor) ? theme.primaryColor : null,
    accent: isHexColor(theme?.accentColor) ? theme.accentColor : null,
  };
}
