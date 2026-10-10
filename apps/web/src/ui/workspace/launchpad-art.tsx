import { useId, type CSSProperties } from 'react';
import { isHexColor } from '../muse/paint';

/** An identity study, not a screenshot of the deployed site. */
export function LaunchpadArt({
  name,
  slug,
  primary,
  accent,
}: {
  name: string;
  slug: string;
  primary: string | null;
  accent: string | null;
}) {
  const id = useId().replace(/:/g, '');
  const seed = Array.from(slug).reduce((value, letter) => value + letter.charCodeAt(0), 0);
  const style = {
    '--pad-primary': isHexColor(primary) ? primary : '#8c9da1',
    '--pad-accent': isHexColor(accent) ? accent : '#bd937b',
  } as CSSProperties;
  return (
    <div className="fw-pad-art" data-study={seed % 3} style={style} aria-hidden="true">
      <div className="fw-pad-art-grid" />
      <span className="fw-pad-art-initial">{name.slice(0, 1)}</span>
      <svg className="fw-pad-art-sculpture" viewBox="0 0 400 320" fill="none">
        <defs>
          <linearGradient id={`${id}-metal`} x1="90" y1="30" x2="310" y2="280" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--pad-accent)" />
            <stop offset=".34" stopColor="#eee9dc" />
            <stop offset=".58" stopColor="var(--pad-primary)" />
            <stop offset="1" stopColor="#30383c" />
          </linearGradient>
        </defs>
        <g className="fw-pad-art-rings" transform="translate(200 160) rotate(-28)">
          {Array.from({ length: 9 }, (_, i) => (
            <ellipse key={i} rx={134 - i * 10} ry={113 - i * 8} stroke={`url(#${id}-metal)`} strokeWidth={3.8} transform={`rotate(${i * 8})`} />
          ))}
        </g>
        <path d="M200 113 213 147 247 160 213 173 200 207 187 173 153 160 187 147Z" fill={`url(#${id}-metal)`} />
        <circle cx="200" cy="160" r="145" stroke="var(--pad-primary)" strokeDasharray="1 8" opacity=".5" />
      </svg>
      <span className="fw-pad-art-wordmark">{name}</span>
      <span className="fw-pad-art-coordinates">{String(seed % 100).padStart(2, '0')} / {slug.toUpperCase()}</span>
    </div>
  );
}
