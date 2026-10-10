import { notFound } from 'next/navigation';
import { WorkshopDesignPreview } from '@/ui/workspace/design-preview';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workshop design preview — FORGE', robots: { index: false, follow: false } };

export default function WorkshopPreviewPage() {
  if (process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_USE_MOCKS !== '1') notFound();
  return <WorkshopDesignPreview />;
}
