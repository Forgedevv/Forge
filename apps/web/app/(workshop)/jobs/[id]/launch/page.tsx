import { LaunchScreen } from '@/ui/workspace/launch';
export const metadata = { title: 'Launch your coin — FORGE' };
export default async function LaunchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LaunchScreen jobId={id} />;
}
