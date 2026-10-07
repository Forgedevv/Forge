import { JobScreen } from '@/ui/workspace/job';
export const metadata = { title: 'Build progress — FORGE' };
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobScreen jobId={id} />;
}
