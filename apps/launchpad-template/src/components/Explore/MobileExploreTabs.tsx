import React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { useExplore } from '@/contexts/ExploreProvider';
import { ExploreTab } from './types';
import { PausedIndicator } from './PausedIndicator';
import { cn } from '@/lib/utils';
import { ExploreTabTitleMap } from './ExploreColumn';

export const MobileExploreTabs = () => {
  const { mobileTab, setMobileTab, pausedTabs } = useExplore();
  return (
    // Part of the market card, in the document flow: a sticky bar inside a card that clips its
    // corners (`overflow: hidden`) sticks to the card instead of the viewport, leaving an empty
    // strip above the tabs and covering the top of the list.
    <div className="launchpad-mobile-tabs relative border-b border-neutral-850 lg:hidden">
      <div className="px-2 py-1">
        <ToggleGroupPrimitive.Root
          className="flex h-10 w-full min-w-fit items-center gap-1 text-sm touch:h-11"
          type="single"
          value={mobileTab}
          onValueChange={(value) => {
            if (value) {
              setMobileTab(value as ExploreTab);
            }
          }}
        >
          <ToggleGroupItem value={ExploreTab.NEW}>
            {ExploreTabTitleMap[ExploreTab.NEW]}
            {mobileTab === ExploreTab.NEW && pausedTabs[ExploreTab.NEW] && <PausedIndicator />}
          </ToggleGroupItem>
          <ToggleGroupItem value={ExploreTab.GRADUATING}>
            {ExploreTabTitleMap[ExploreTab.GRADUATING]}
            {mobileTab === ExploreTab.GRADUATING && pausedTabs[ExploreTab.GRADUATING] && (
              <PausedIndicator />
            )}
          </ToggleGroupItem>
          <ToggleGroupItem value={ExploreTab.GRADUATED}>
            {ExploreTabTitleMap[ExploreTab.GRADUATED]}
            {mobileTab === ExploreTab.GRADUATED && pausedTabs[ExploreTab.GRADUATED] && (
              <PausedIndicator />
            )}
          </ToggleGroupItem>
        </ToggleGroupPrimitive.Root>
      </div>
    </div>
  );
};

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => {
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        'flex h-full w-full items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 text-neutral-400 transition-all',
        'data-[state=off]:hover:text-primary/80',
        'data-[state=on]:bg-primary/10 data-[state=on]:text-primary',
        'disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        className,
      )}
      {...props}
    />
  );
});
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;
