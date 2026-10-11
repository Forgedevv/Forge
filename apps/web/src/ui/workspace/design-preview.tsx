'use client';

import { useMemo } from 'react';
import { createMockController } from '../mocks/client';
import { DashboardScreen } from './dashboard';
import { WorkspaceProvider } from './provider';
import { WorkspaceFrame } from './shell';

/** Isolated development portfolio; it cannot connect a wallet or move funds. */
export function WorkshopDesignPreview() {
  const controller = useMemo(() => createMockController('dashboard:three'), []);
  return (
    <WorkspaceProvider controller={controller}>
      <WorkspaceFrame requireSession={false}>
        <DashboardScreen />
      </WorkspaceFrame>
    </WorkspaceProvider>
  );
}
