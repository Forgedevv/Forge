import { FaqScreen } from '@/ui/workspace/documents';
import { WorkspaceFrame } from '@/ui/workspace/shell';
export const metadata = { title: 'FAQ ? FORGE' };
export default function Page() {
  return (
    <WorkspaceFrame requireSession={false}>
      <FaqScreen />
    </WorkspaceFrame>
  );
}
