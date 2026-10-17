import { useState, type MouseEvent } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/Dialog';
import { siteConfig } from './config';
import { TradePanel, type TradePanelProps } from './TradePanel';
import { TRADE_TEXT } from './trade/copy';

export interface BuyButtonProps extends Omit<TradePanelProps, 'className'> {
  /** Button text. */
  label?: string;
  className?: string;
}

/**
 * Compact buy call-to-action for coin cards. It opens the full `TradePanel` in a dialog, so the
 * quote and the fees are always shown before anything is signed. The click never bubbles to the
 * card (which links to the coin page).
 *
 * On `sleeping` / `disabled` sites it renders as a disabled button and opens nothing.
 */
export function BuyButton({
  label = TRADE_TEXT.buyButton.label,
  className,
  ...panelProps
}: BuyButtonProps) {
  const [open, setOpen] = useState(false);
  const live = siteConfig.mode === 'live';
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
  };
  const buttonClass = `rounded-[var(--radius)] bg-[var(--color-primary,#7c3aed)] px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ''}`;

  if (!live) {
    return (
      <button
        type="button"
        disabled
        className={buttonClass}
        title={TRADE_TEXT.buyButton.notAvailable}
        data-forge="buy-button"
        data-testid="buy-button"
      >
        {label}
      </button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={buttonClass}
          onClick={stop}
          data-forge="buy-button"
          data-testid="buy-button"
        >
          {label}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md p-0" onClick={stop}>
        <DialogTitle className="sr-only">
          {TRADE_TEXT.buyButton.dialogTitle(panelProps.symbol)}
        </DialogTitle>
        <TradePanel {...panelProps} />
      </DialogContent>
    </Dialog>
  );
}

export default BuyButton;
