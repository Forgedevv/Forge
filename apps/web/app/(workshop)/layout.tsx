import type { ReactNode } from 'react';
import { WorkspaceFrame } from '@/ui/workspace/shell';
export default function WorkshopLayout({ children }: { children: ReactNode }) {
  return <WorkspaceFrame>{children}</WorkspaceFrame>;
}
