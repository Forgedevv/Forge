import Header from '@/components/Header';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { content } from '@/content';

interface IProps {
  containerClassName?: string;
  pageClassName?: string;
}

const Page: React.FC<React.PropsWithChildren<IProps>> = ({
  containerClassName,
  children,
  pageClassName,
}) => {
  return (
    <div
      className={cn(
        'flex min-h-screen flex-col justify-between bg-background text-foreground',
        pageClassName,
      )}
    >
      <Header />
      {/* Full-width content with a modest gutter around it */}
      <div
        className={cn(
          'launchpad-body flex flex-1 flex-col items-center',
          containerClassName,
        )}
      >
        <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-1 flex-col">{children}</div>
      </div>
      <footer className="launchpad-footer flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>{content.strings.footerNote}</span>
        <Link href="/about" className="launchpad-nav-link inline-flex w-fit items-center px-2 py-1">
          {content.strings.aboutTitle}
        </Link>
      </footer>
    </div>
  );
};

export default Page;
