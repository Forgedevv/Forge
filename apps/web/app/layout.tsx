import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { homeContent } from '@/ui/home/content';

export const metadata: Metadata = {
  title: homeContent.title,
  description: homeContent.description,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
