import { useId } from 'react';
import { cn } from '@/lib/utils';
import { content } from '@/content';

type LogoProps = {
  className?: string;
  /** Accessible name. Omit it when the logo sits next to the visible launchpad name. */
  title?: string;
};

/**
 * Logo mark of the launchpad (FREE ZONE). Header and footer render it; replace this drawing with
 * the launchpad's own mark (inline SVG, colours from the theme variables), keeping the props.
 * The default mark is a faceted badge with the launchpad initial.
 */
export function Logo({ className, title }: LogoProps) {
  const id = useId().replace(/:/g, '');
  const initial = content.name.slice(0, 1).toUpperCase();
  return (
    <svg
      className={cn('launchpad-logo', className)}
      viewBox="0 0 40 40"
      fill="none"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient
          id={`${id}-face`}
          x1="4"
          y1="2"
          x2="36"
          y2="38"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--color-primary)" />
          <stop
            offset="1"
            stopColor="color-mix(in srgb, var(--color-primary) 55%, var(--color-accent))"
          />
        </linearGradient>
      </defs>
      <path d="M20 2 35.6 11v18L20 38 4.4 29V11L20 2Z" fill={`url(#${id}-face)`} />
      <path d="M20 2 35.6 11 20 20 4.4 11 20 2Z" fill="var(--color-bg)" opacity=".16" />
      <path d="M20 20v18" stroke="var(--color-bg)" strokeOpacity=".22" />
      <text
        x="20"
        y="26.5"
        textAnchor="middle"
        className="launchpad-logo-letter"
        fill="rgb(var(--primary-950))"
      >
        {initial}
      </text>
    </svg>
  );
}

export default Logo;
