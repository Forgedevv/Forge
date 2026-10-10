import Link from 'next/link';
import { cn } from '@/lib/utils';
import { buttonVariants } from './ui/button';
import { content } from '@/content';

type CreatePoolButtonProps = {
  className?: string;
};

export const CreatePoolButton = ({ className }: CreatePoolButtonProps) => {
  return (
    <Link
      href="/create-pool"
      className={cn('launchpad-header-create', buttonVariants({ variant: 'outline' }), className)}
    >
      <span className="iconify ph--rocket-bold h-4 w-4" />
      <span className="hidden sm:inline">{content.strings.createCoin}</span>
      <span className="sm:hidden">{content.strings.createPoolCompact}</span>
    </Link>
  );
};
