import { TermsScreen } from '@/ui/workspace/documents';
import { WorkspaceFrame } from '@/ui/workspace/shell';
export const metadata = { title: 'Terms ? FORGE' };
export default function Page() {
  return (
    <WorkspaceFrame requireSession={false}>
      <TermsScreen />
    </WorkspaceFrame>
  );
}
