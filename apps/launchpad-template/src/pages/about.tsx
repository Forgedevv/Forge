import Head from 'next/head';
import Page from '@/components/ui/Page/Page';
import { content } from '@/content';

export default function AboutPage() {
  return (
    <Page>
      <Head>
        <title>{`${content.strings.aboutTitle} - ${content.name}`}</title>
      </Head>
      <article className="launchpad-about">
        <p className="launchpad-eyebrow">{content.strings.aboutEyebrow}</p>
        <h1>{content.strings.aboutTitle}</h1>
        <p className="launchpad-about-copy">{content.about}</p>
      </article>
    </Page>
  );
}
