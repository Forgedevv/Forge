import { DragMarquee } from '@/components/library/motion/DragMarquee';
import { cn } from '@/lib/utils';
import { FooterNav, HEADING_FONT } from '../shared';
import { footerCopy, type FooterProps } from './FooterWordmark';

/**
 * Footer opened by a slow ticker of the site name in outlined giant type, links and the legal note
 * beneath. Meme, playful and retro launchpads.
 */
export function FooterMarquee(props: FooterProps) {
  const copy = footerCopy(props);
  return (
    <footer
      className={cn('overflow-hidden border-t border-[var(--color-border)]', props.className)}
    >
      <div className="border-b border-[var(--color-border)] py-6">
        <DragMarquee label={copy.name} speed={28} gap={48} pauseButton={false}>
          {[0, 1, 2].map((key) => (
            <span
              key={key}
              aria-hidden="true"
              className={cn(
                HEADING_FONT,
                'flex items-center gap-12 text-[clamp(3rem,9vw,7rem)] uppercase leading-none text-transparent [-webkit-text-stroke:1px_var(--color-text)]',
              )}
            >
              {copy.name}
              <span className="text-[0.4em] text-[var(--color-primary)] [-webkit-text-stroke:0]">
                ✦
              </span>
            </span>
          ))}
        </DragMarquee>
      </div>
      <div className="flex flex-col gap-6 px-[var(--page-gutter)] py-8 md:flex-row md:items-center md:justify-between">
        <FooterNav links={copy.links} />
        <div className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)] md:text-right">
          <span>{copy.note}</span>
          <span>{copy.disclaimer}</span>
        </div>
      </div>
    </footer>
  );
}

export default FooterMarquee;
