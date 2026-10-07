import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { homeContent } from '@/ui/home/content';
import { WorkspaceProvider } from '@/ui/workspace/provider';

export const metadata: Metadata = {
  title: homeContent.title,
  description: homeContent.description,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </body>
    </html>
  );
}
