import { notFound } from 'next/navigation';
import { StateGallery } from '@/ui/workspace/gallery';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'State gallery — FORGE', robots: { index: false, follow: false } };
export default async function StatesPage({
  searchParams,
}: {
  searchParams: Promise<{ receipt?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { receipt } = await searchParams;
  return (
    <StateGallery enabled={process.env.NEXT_PUBLIC_USE_MOCKS === '1'} receipt={Boolean(receipt)} />
  );
}
