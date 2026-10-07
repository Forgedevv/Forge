import { NewScreen } from '@/ui/workspace/chat';
export const metadata = { title: 'Request a change — FORGE' };
export default async function ModifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NewScreen launchpadId={id} />;
}
