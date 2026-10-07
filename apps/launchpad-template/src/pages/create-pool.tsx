import Head from 'next/head';
import Header from '@/components/Header';
import CreateCoin from '@/forge/CreateCoin';
import { siteConfig } from '@/content';

export default function CreatePoolPage() {
  return (
    <>
      <Head>
        <title>{`Create a coin - ${siteConfig.name}`}</title>
        <meta name="description" content={siteConfig.content.tagline} />
      </Head>

      <div className="min-h-screen bg-background text-foreground">
        <Header />

        <main className="mx-auto w-full max-w-3xl px-4 py-8 md:py-12">
          <div className="mb-8 flex flex-col items-start justify-between md:mb-10 md:flex-row md:items-center">
            <div>
              <h1 className="mb-2 text-3xl font-bold tracking-tight md:text-4xl">Create Pool</h1>
              <p className="text-neutral-400">Launch your token with a customizable price curve</p>
            </div>
          </div>

          <CreateCoin />
        </main>
      </div>
    </>
  );
}
