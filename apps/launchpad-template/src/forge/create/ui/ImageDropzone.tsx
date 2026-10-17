import { useRef, useState } from 'react';
import { CREATE_COIN_TEXT } from '../copy';
import { IMAGE_TYPES } from '../validation';
import { ui } from './styles';

const TEXT = CREATE_COIN_TEXT.image;

export interface ImageDropzoneProps {
  /** Id of the (visually hidden) file input; the field label points to it. */
  id: string;
  file: File | null;
  /** Object URL of `file` for the preview (null while none, or where object URLs are missing). */
  previewUrl: string | null;
  /** A picked or dropped file (null: removed). The caller validates it. */
  onPick: (file: File | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * LOCKED ZONE. Coin image picker: a styled drop zone over a visually hidden native file input
 * (so click, keyboard and screen readers work as for any file input, without the browser's
 * "Choose file / No file chosen" text). Shows the picked image at once, cropped to a square,
 * with the circle the market list shows; the file can be replaced or removed.
 */
export function ImageDropzone(props: ImageDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { file, previewUrl, disabled } = props;

  const pickFromList = (files: FileList | null | undefined) => {
    const next = files?.[0] ?? null;
    if (next) props.onPick(next);
  };

  return (
    <div className="relative" data-forge="create-coin-image">
      <input
        ref={inputRef}
        id={props.id}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        className="peer sr-only"
        disabled={disabled}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        onChange={(event) => {
          pickFromList(event.target.files);
          // Picking the same file again after removing it must fire a change.
          event.target.value = '';
        }}
      />
      <label
        htmlFor={props.id}
        data-dragging={dragging || undefined}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled) pickFromList(event.dataTransfer.files);
        }}
        className={[
          'group relative flex w-full cursor-pointer items-center gap-4 overflow-hidden rounded-[var(--radius-card)] border-2 border-dashed bg-background p-3 text-left transition-colors',
          'md:aspect-square md:flex-col md:justify-center md:gap-2 md:p-4 md:text-center',
          'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--color-accent)]',
          'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
          props.invalid ? 'border-rose/60' : 'border-neutral-750 hover:border-primary/60',
          dragging ? 'border-primary bg-primary/5' : '',
        ].join(' ')}
      >
        {previewUrl ? (
          <>
            <span className="relative block aspect-square w-20 shrink-0 overflow-hidden rounded-[var(--radius)] md:absolute md:inset-0 md:h-full md:w-full md:rounded-none">
              {/* A local object URL of the picked file: never a remote address. */}
              <img
                src={previewUrl}
                alt={TEXT.previewAlt}
                className="h-full w-full object-cover"
                draggable={false}
              />
              {/* The circle the market list crops the image to. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-[6%] rounded-full shadow-[0_0_0_999px_rgb(var(--background)/0.55)] ring-1 ring-foreground/40"
              />
            </span>
            <span className="min-w-0 text-xs text-neutral-300 md:sr-only">{TEXT.cropNote}</span>
            <span className="absolute bottom-2 right-2 hidden rounded-[var(--radius)] bg-background/85 px-2 py-1 text-xs font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100 md:block motion-reduce:transition-none">
              {TEXT.replace}
            </span>
          </>
        ) : (
          <>
            <span
              aria-hidden="true"
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full border border-neutral-750 bg-neutral-925 text-neutral-400 transition-colors group-hover:text-primary md:h-12 md:w-12"
            >
              <span className="iconify ph--image-square-bold h-6 w-6" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {dragging ? TEXT.dropActive : TEXT.dropTitle}
              </span>
              <span className="block text-xs text-neutral-400">{TEXT.dropAction}</span>
            </span>
          </>
        )}
      </label>

      {file ? (
        <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-neutral-400">
          <span className="min-w-0 flex-1 truncate" title={file.name}>
            {file.name}
          </span>
          <span className="shrink-0 tabular-nums">{formatSize(file.size)}</span>
          <button
            type="button"
            className={ui.textButton}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {TEXT.replace}
          </button>
          <button
            type="button"
            className={ui.textButton}
            disabled={disabled}
            onClick={() => props.onPick(null)}
          >
            {TEXT.remove}
          </button>
        </div>
      ) : null}
    </div>
  );
}
