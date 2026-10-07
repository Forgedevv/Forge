import Link from 'next/link';
import { ForgeMark, ProductDetails } from '@/ui/home/home';
import { homeContent as copy } from '@/ui/home/content';
import '@/ui/home/home.css';

export const metadata = { title: `${copy.faq} — ${copy.brand}` };

export default function FaqPage() {
  return (
    <main className="forge-document">
      <header>
        <Link href="/" className="forge-brand">
          <ForgeMark />
          {copy.brand}
        </Link>
        <Link href="/">{copy.termsPage.back}</Link>
      </header>
      <h1 className="forge-sr-only">{copy.faq}</h1>
      <ProductDetails />
    </main>
  );
}
