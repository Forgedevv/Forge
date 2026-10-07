import Head from 'next/head';
import Page from '@/components/ui/Page/Page';
import { content } from '@/content';

export default function AboutPage() {
  return (
    <Page>
      <Head>
        <title>{`${content.strings.aboutTitle} - ${content.name}`}</title>
      </Head>
      <article className="mx-auto w-full max-w-3xl px-2 py-8">
        <h1 className="mb-4 text-3xl font-bold tracking-tight">{content.strings.aboutTitle}</h1>
        <p className="whitespace-pre-line text-neutral-300">{content.about}</p>
      </article>
    </Page>
  );
}
