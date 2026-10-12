import Header from '@/components/Header';
import { cn } from '@/lib/utils';
import { SiteFooter } from '@/components/SiteFooter';

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
      <div className={cn('launchpad-body flex flex-1 flex-col items-center', containerClassName)}>
        <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-1 flex-col">
          {children}
        </div>
      </div>
      <SiteFooter />
    </div>
  );
};

export default Page;
