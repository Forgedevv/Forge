import Head from 'next/head';
import { content } from '@/content';

/** Static maintenance page shown when the site is disabled. */
export function DisabledPage() {
  return (
    <>
      <Head>
        <title>{content.name}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center text-foreground">
        <h1 className="text-2xl font-semibold">{content.strings.disabledTitle}</h1>
      </main>
    </>
  );
}

export default DisabledPage;
