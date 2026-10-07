import { DetailScreen } from '@/ui/workspace/detail';
export const metadata = { title: 'Launchpad details — FORGE' };
export default async function DetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DetailScreen launchpadId={id} />;
}
