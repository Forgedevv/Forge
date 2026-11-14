import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Space_Grotesk, Unbounded } from 'next/font/google';
import './globals.css';
import { homeContent } from '@/ui/home/content';
import { prelaunchForRequest } from '@/server/prelaunch/request';
import { WorkspaceProvider } from '@/ui/workspace/provider';

const sans = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  display: 'swap',
});
const display = Unbounded({
  subsets: ['latin'],
  weight: ['700'],
  variable: '--font-unbounded',
  display: 'swap',
});

export const metadata: Metadata = {
  title: homeContent.title,
  description: homeContent.description,
  openGraph: {
    title: homeContent.title,
    description: homeContent.description,
    siteName: homeContent.brand,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: homeContent.title,
    description: homeContent.description,
  },
};

// Every page renders per request: the pre-launch mode is read from the environment and a cookie.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const prelaunch = await prelaunchForRequest();
  return (
    <html lang="en" className={`dark ${sans.variable} ${display.variable}`}>
      <body>
        <WorkspaceProvider prelaunch={prelaunch}>{children}</WorkspaceProvider>
      </body>
    </html>
  );
}
