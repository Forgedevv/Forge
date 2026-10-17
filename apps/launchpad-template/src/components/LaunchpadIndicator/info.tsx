import { IconProps } from '@/icons/types';
import { Launchpad } from '../Explore/types';
import { DBCIcon } from '@/icons/DBCIcon';

type LaunchpadInfo = {
  label: string;
  /**
   * The link to the launchpad website for a token
   */
  href?: (id: string) => string | undefined;
  icon: React.FC<IconProps>;
  /** Theme colors (CSS values), so the chip follows the site theme. */
  color: string;
  borderColor: string;
  /**
   * Whether we support the launchpad bonding curve
   */
  bondingCurveSupported?: boolean;
};

/**
 * The launchpads a coin of this site can come from. A FORGE launchpad only lists its own coins,
 * all on Meteora's Dynamic Bonding Curve, so only that one is known: other launchpads' brands are
 * not bundled.
 */
export const LaunchpadInfo: Partial<Record<Launchpad, LaunchpadInfo>> = {
  [Launchpad.DBC]: {
    label: 'Meteora DBC',
    icon: (props) => <DBCIcon aria-label="Meteora DBC" {...props} />,
    color: 'var(--color-text-muted)',
    borderColor: 'var(--color-border)',
    bondingCurveSupported: true,
  },
};

export const LAUNCHPAD_INFOS = Object.entries(LaunchpadInfo).map(([launchpad, info]) => ({
  launchpad: launchpad as Launchpad,
  info,
}));

export function getLaunchpadInfo(launchpad?: string): LaunchpadInfo | null {
  if (!launchpad) return null;
  return LaunchpadInfo[launchpad as keyof typeof LaunchpadInfo] ?? null;
}
