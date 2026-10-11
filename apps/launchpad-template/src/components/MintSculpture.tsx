import { useId } from 'react';

/** Local vector artwork. All finish colors are supplied by the site's theme. */
export function MintSculpture({ monogram }: { monogram: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="launchpad-mint" viewBox="0 0 560 420" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-edge`} x1="85" y1="65" x2="475" y2="365" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--mint-highlight)" />
          <stop offset=".28" stopColor="var(--mint-metal)" />
          <stop offset=".52" stopColor="var(--mint-shadow)" />
          <stop offset=".7" stopColor="var(--mint-highlight)" />
          <stop offset="1" stopColor="var(--mint-shadow)" />
        </linearGradient>
        <radialGradient id={`${id}-face`} cx=".3" cy=".23" r=".8">
          <stop stopColor="var(--mint-highlight)" />
          <stop offset=".45" stopColor="var(--mint-metal)" />
          <stop offset="1" stopColor="var(--mint-shadow)" />
        </radialGradient>
      </defs>
      <ellipse cx="285" cy="365" rx="171" ry="19" fill="var(--color-text)" opacity=".05" />
      <g className="launchpad-mint-back">
        <g transform="translate(351 210) rotate(24) scale(.72 1)">
          <circle cy="13" r="130" fill={`url(#${id}-edge)`} />
          <circle r="130" fill={`url(#${id}-face)`} />
          <circle r="116" stroke="var(--mint-highlight)" opacity=".5" />
          <circle r="100" stroke="var(--mint-shadow)" opacity=".5" />
          {Array.from({ length: 48 }, (_, i) => (
            <path key={i} d="M0 -110V-119" transform={`rotate(${i * 7.5})`} stroke="var(--mint-shadow)" opacity=".6" />
          ))}
          <path d="M0 -70 19 -19 70 0 19 19 0 70 -19 19 -70 0 -19 -19Z" fill="var(--mint-highlight)" opacity=".8" />
        </g>
      </g>
      <g className="launchpad-mint-front">
        <g transform="translate(231 222) rotate(-24) scale(.77 1)">
          <circle cy="15" r="139" fill={`url(#${id}-edge)`} />
          <circle r="139" fill={`url(#${id}-face)`} />
          <circle r="129" stroke="var(--mint-highlight)" opacity=".65" />
          <circle r="106" stroke="var(--mint-shadow)" opacity=".55" />
          {Array.from({ length: 64 }, (_, i) => (
            <path key={i} d="M0 -116V-124" transform={`rotate(${i * 5.625})`} stroke="var(--mint-shadow)" opacity=".55" />
          ))}
          <text x="0" y="36" textAnchor="middle" className="launchpad-mint-letter" fill="var(--mint-shadow)">{monogram}</text>
          <path d="M-25 72H25" stroke="var(--mint-highlight)" opacity=".6" />
        </g>
      </g>
      <path d="M100 85H140M120 65V105M436 332H460M448 320V344" stroke="var(--color-text-muted)" opacity=".4" />
      <circle cx="280" cy="210" r="183" stroke="var(--color-border)" strokeDasharray="2 9" opacity=".45" />
    </svg>
  );
}
