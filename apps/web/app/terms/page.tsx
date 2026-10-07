import Link from 'next/link';
import { ForgeMark } from '@/ui/home/home';
import { homeContent as copy } from '@/ui/home/content';
import '@/ui/home/home.css';

export const metadata = { title: `${copy.terms} — ${copy.brand}` };

export default function TermsPage() {
  return (
    <main className="forge-document">
      <header>
        <Link href="/" className="forge-brand">
          <ForgeMark />
          {copy.brand}
        </Link>
        <Link href="/">{copy.termsPage.back}</Link>
      </header>
      <article className="forge-terms">
        <p className="forge-eyebrow">{copy.termsPage.label}</p>
        <h1>{copy.termsPage.title}</h1>
        <p>{copy.termsPage.body}</p>
        <p>{copy.termsPage.note}</p>
        <Link className="forge-text-link" href="/faq">
          {copy.faq} ↗
        </Link>
      </article>
    </main>
  );
}
