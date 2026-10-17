import { useMemo } from 'react';

import { useTrenchesTokenIconContext } from '@/forge/token-icon/Context';
import { cn } from '@/lib/utils';
import { Asset } from '../Explore/types';
import { getLaunchpadInfo } from './info';

type LaunchpadIndicatorProps = {
  launchpad: Asset['launchpad'];
  className?: string;
};

type TrenchesTokenIconLaunchpadProps = {
  className?: string;
};

/**
 * Optional launchpad chip on a token icon, for free-zone code that wants one: render it inside a
 * `TrenchesTokenIconRoot`. The FORGE token icons no longer draw it (every coin of the site is on
 * the same launchpad, so it told visitors nothing). Styled with the theme variables.
 */
export const TrenchesTokenIconLaunchpad: React.FC<TrenchesTokenIconLaunchpadProps> = (props) => {
  const { token, width, height, hideLaunchpad } = useTrenchesTokenIconContext();

  if (hideLaunchpad === true || !token?.launchpad) {
    return null;
  }

  const isLargeIcon = width >= 40 && height >= 40;

  return (
    <LaunchpadIndicator
      {...props}
      launchpad={token?.launchpad}
      className={cn(props.className, {
        '[&_svg]:h-2.5 [&_svg]:w-2.5': isLargeIcon,
      })}
    />
  );
};

export const LaunchpadIndicator: React.FC<LaunchpadIndicatorProps> = ({ launchpad, className }) => {
  const config = useMemo(() => getLaunchpadInfo(launchpad), [launchpad]);

  if (!config) return null;

  const Icon = config.icon;

  return (
    <div
      className={cn(
        'absolute -bottom-px -right-1',
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full border bg-[var(--color-surface)] p-0.5',
        className,
      )}
      style={{ borderColor: config.borderColor }}
    >
      <Icon className="h-2 w-2" />
    </div>
  );
};
