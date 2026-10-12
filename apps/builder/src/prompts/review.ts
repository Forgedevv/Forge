import type { LaunchpadSpec } from '@forge/shared';

/**
 * Task prompt of the second agent pass (visual review): the site of the first pass was built and
 * rendered in a headless browser on day one (no coin yet); the screenshots and a machine-measured
 * layout report are in `.forge-review/`. The system prompt stays `builderSystemPrompt()`.
 *
 * Everything that comes from the capture is data measured on the agent's own site, already
 * validated by the builder; it is filtered again here to a short, safe character set.
 */

export interface ReviewShotSummary {
  /** Page id (`home`, `create-pool`, `about`, `creator-fees`). */
  page: string;
  /** Route (`/`, `/create-pool`...). */
  path: string;
  viewport: 'desktop' | 'mobile';
  width: number;
  height: number;
  /** The page rendered and was captured. */
  captured: boolean;
  /** Screenshot parts, project-relative paths, top first. */
  images: string[];
  /** The page is taller than the captured height. */
  truncated: boolean;
  /** Measured layout; null when the page could not be measured. */
  layout: {
    clientWidth: number;
    scrollWidth: number;
    overflowingCount: number;
    /** Elements whose right edge passes the viewport: tag, id and classes. */
    overflowing: ReadonlyArray<{
      tag: string;
      id: string;
      classes: readonly string[];
      right: number;
    }>;
  } | null;
  consoleErrors: number;
}

export interface ReviewTaskInput {
  /** Folder of the review input (`.forge-review`). */
  reviewDir: string;
  /** Full measured report (`.forge-review/report.json`). */
  reportPath: string;
  shots: readonly ReviewShotSummary[];
}

/** JSON with `<` and `>` escaped, so client text can never close the `client_request` block. */
function encodeClientInput(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

const SAFE_TOKEN_RE = /[^A-Za-z0-9_:/.[\]%#()!-]/g;

function token(value: string, max = 64): string {
  return value.replace(SAFE_TOKEN_RE, '').slice(0, max);
}

function selector(e: { tag: string; id: string; classes: readonly string[] }): string {
  const tag = /^[a-z][a-z0-9-]{0,31}$/.test(e.tag) ? e.tag : 'element';
  const id = token(e.id) ? `#${token(e.id)}` : '';
  const classes = e.classes
    .map((c) => token(c))
    .filter(Boolean)
    .slice(0, 6)
    .map((c) => `.${c}`)
    .join('');
  return `${tag}${id}${classes}`;
}

function int(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** One line (plus overflow details) of the measured report, per page and viewport. */
function findingLines(shot: ReviewShotSummary): string[] {
  const where = `- \`${token(shot.path)}\` ${shot.viewport} (${int(shot.width)}x${int(shot.height)})`;
  if (!shot.captured || !shot.layout) {
    return [`${where}: could not be rendered or measured. Check this page in the code.`];
  }
  const { clientWidth, scrollWidth, overflowingCount, overflowing } = shot.layout;
  const errors =
    shot.consoleErrors > 0 ? ` ${int(shot.consoleErrors)} console error(s), see the report.` : '';
  if (scrollWidth <= clientWidth && overflowingCount === 0) {
    return [
      `${where}: no horizontal overflow (page width ${int(scrollWidth)} px = viewport ${int(clientWidth)} px).${errors}`,
    ];
  }
  const lines = [
    `${where}: HORIZONTAL OVERFLOW, page width ${int(scrollWidth)} px for a ${int(clientWidth)} px viewport, ${int(overflowingCount)} element(s) past the right edge.${errors}`,
  ];
  for (const e of overflowing.slice(0, 10)) {
    lines.push(`  - \`${selector(e)}\` ends at ${int(e.right)} px`);
  }
  if (overflowingCount > Math.min(overflowing.length, 10)) {
    lines.push(`  - ... and ${int(overflowingCount - Math.min(overflowing.length, 10))} more`);
  }
  return lines;
}

/** The client's brief, as given to the first pass (untrusted, data only). */
function briefOf(spec: LaunchpadSpec): Record<string, unknown> {
  return {
    launchpadName: spec.name,
    tagline: spec.theme.tagline,
    primaryColor: spec.theme.primaryColor,
    accentColor: spec.theme.accentColor,
    darkMode: spec.theme.darkMode,
    designNotes: spec.theme.designNotes,
    launchpadCoin: {
      name: spec.launchpadCoin.name,
      symbol: spec.launchpadCoin.symbol,
      description: spec.launchpadCoin.description,
    },
  };
}

/** Task of the review pass: look at the rendered site, fix what is wrong, keep what works. */
export function reviewTaskPrompt(input: ReviewTaskInput, spec: LaunchpadSpec): string {
  const dir = token(input.reviewDir);
  const images = input.shots.flatMap((s) =>
    s.images.map(
      (image, i) =>
        `- \`${token(image, 128)}\`: \`${token(s.path)}\` on ${s.viewport} (${int(s.width)} px wide)${
          s.images.length > 1 ? `, part ${i + 1} of ${s.images.length}` : ''
        }${s.truncated && i === s.images.length - 1 ? ', the page continues below' : ''}`,
    ),
  );
  return [
    'Review and improve the launchpad site in the current directory, which you designed for the',
    "client's brief below. It was built and rendered in a headless browser with no network, as a",
    'brand new launchpad with no coin yet (day one). You now get to see it.',
    '',
    `The screenshots and a measured layout report are in \`${dir}/\`:`,
    ...(images.length > 0 ? images : ['- (no screenshot could be taken)']),
    `- \`${token(input.reportPath, 128)}\`: the full measured report (JSON).`,
    '',
    'Do this, in order:',
    '1. Read every screenshot with the Read tool before you change anything.',
    '2. Horizontal overflow: trust only the measured report below, never your impression of a',
    '   screenshot. It lists every element whose right edge passes the viewport and compares the',
    '   page width to the viewport. Fix each overflow it lists. Where it reports no overflow there is',
    '   none: do not change widths, paddings or wrapping to fix an overflow you think you see.',
    '3. Day one: the market is empty because no coin exists yet. Make that state look intended and',
    '   inviting (a clear message and a call to create the first coin), and make sure no large area',
    '   of any page looks dead or empty. Keep the market and every `src/forge/` component in place.',
    '4. Visual hierarchy, spacing, alignment and contrast: readable text and buttons on every',
    '   background, one clear focal point per section, consistent spacing, nothing overlapping or',
    '   cut off, on desktop and on mobile.',
    '5. Carry the design through every page: the create, about and creator fees pages must share the',
    "   home page's look (typography, colors, backgrounds, cards, buttons), not only its colors.",
    '   `src/pages/creator-fees.*` itself is locked: style it through the theme and the shared',
    '   components it uses.',
    '6. Keep what already works. Improve the existing design, do not start over.',
    '',
    'Rules:',
    '- Every rule of the system prompt still applies: the same zones, locked files and security rules.',
    `- Do not create, edit or delete anything in \`${dir}/\`. It is removed before your changes are`,
    '  checked, and nothing you write there is kept. Never copy its files into the site.',
    '- When you are done, reply with a short summary of what you changed, in one paragraph.',
    '',
    'Measured layout report (one line per page and viewport):',
    ...input.shots.flatMap(findingLines),
    '',
    `<client_request>\n${encodeClientInput(briefOf(spec))}\n</client_request>`,
  ].join('\n');
}
