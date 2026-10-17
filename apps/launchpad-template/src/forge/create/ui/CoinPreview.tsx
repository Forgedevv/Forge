import { CREATE_COIN_TEXT } from '../copy';
import { ui } from './styles';

const TEXT = CREATE_COIN_TEXT.preview;

export interface CoinPreviewProps {
  name: string;
  symbol: string;
  description?: string;
  /** Object URL of the picked image, or null. */
  imageUrl: string | null;
  /** Hides the heading (when the preview sits inside another summary). */
  compact?: boolean;
  className?: string;
}

/** Round coin image (or its initial) at the size the market list uses. */
export function CoinAvatar({
  name,
  imageUrl,
  size = 54,
}: {
  name: string;
  imageUrl: string | null;
  size?: number;
}) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-neutral-850 bg-neutral-900 font-semibold text-neutral-400"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        initial
      )}
    </span>
  );
}

/**
 * LOCKED ZONE. Live preview of the coin while the visitor types: the same row as the market list
 * (`launchpad-token-row`, round 54 px image, ticker then name), so the site's own styling of the
 * market applies here too.
 */
export function CoinPreview(props: CoinPreviewProps) {
  const name = props.name.trim();
  const symbol = props.symbol.trim().toUpperCase();
  const description = (props.description ?? '').trim();
  return (
    <section
      aria-label={props.compact ? TEXT.title : undefined}
      aria-labelledby={props.compact ? undefined : 'create-coin-preview-title'}
      data-forge="create-coin-preview"
      className={props.className}
    >
      {!props.compact && (
        <header className="mb-3">
          <h2
            id="create-coin-preview-title"
            className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400"
          >
            {TEXT.title}
          </h2>
          <p className="mt-1 text-xs text-neutral-500">{TEXT.intro}</p>
        </header>
      )}
      <div className={`${ui.frame} overflow-hidden`}>
        <div className="launchpad-token-row relative flex items-center gap-3 border-neutral-850 px-3 py-3 text-xs">
          <CoinAvatar name={name || TEXT.namePlaceholder} imageUrl={props.imageUrl} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span
                className={`truncate text-sm font-semibold ${symbol ? 'text-foreground' : 'text-neutral-500'}`}
                title={symbol || undefined}
              >
                {symbol || TEXT.symbolPlaceholder}
              </span>
              <span
                className={`min-w-0 truncate text-xs ${name ? 'text-neutral-400' : 'text-neutral-600'}`}
                title={name || undefined}
              >
                {name || TEXT.namePlaceholder}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-neutral-500">
              <span className="opacity-80">{TEXT.age}</span>
              <span aria-hidden="true">·</span>
              <span>{TEXT.creator}</span>
            </div>
          </div>
        </div>
        {!props.compact && (
          <p
            className={`line-clamp-3 border-t border-neutral-850 px-3 py-2.5 text-xs leading-relaxed [overflow-wrap:anywhere] ${description ? 'text-neutral-300' : 'text-neutral-600'}`}
          >
            {description || TEXT.descriptionPlaceholder}
          </p>
        )}
      </div>
    </section>
  );
}
