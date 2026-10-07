import { notFound } from 'next/navigation';
import '@/ui/workspace/workspace.css';
import { fullSpec } from '@/ui/mocks/fixtures';
export const metadata = {
  title: 'Orbit · Simulated preview',
  robots: { index: false, follow: false },
};
export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_USE_MOCKS !== '1')
    notFound();
  return (
    <main className="fw fw-gallery">
      <p className="fw-demo-banner">Design preview · no live coins or trading.</p>
      <header className="fw-heading">
        <p className="fw-eyebrow">{fullSpec.name} / COMMUNITY LAUNCHPAD</p>
        <span className="fw-orbit" aria-hidden="true">
          ◒
        </span>
        <h1>{fullSpec.theme.tagline}</h1>
        <p>{fullSpec.launchpadCoin.description}</p>
      </header>
      <section className="fw-card">
        <h2>
          {fullSpec.launchpadCoin.name} / {fullSpec.launchpadCoin.symbol}
        </h2>
        <p>This local preview shows the design approval step. Trading is not enabled.</p>
      </section>
    </main>
  );
}
