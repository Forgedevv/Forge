import Head from 'next/head';
import Header from '@/components/Header';
import CreateCoin from '@/forge/CreateCoin';
import { content } from '@/content';

export default function CreatePoolPage() {
  return (
    <>
      <Head>
        <title>{`${content.strings.createCoin} - ${content.name}`}</title>
        <meta name="description" content={content.tagline} />
      </Head>

      <div className="min-h-screen bg-background text-foreground">
        <Header />

        <main className="launchpad-create">
          <header className="launchpad-create-heading">
            <p className="launchpad-eyebrow">{content.strings.createEyebrow}</p>
            <h1>{content.strings.createCoin}</h1>
            <p>{content.strings.createIntro}</p>
          </header>
          <div className="launchpad-create-panel"><CreateCoin /></div>
        </main>
      </div>
    </>
  );
}
