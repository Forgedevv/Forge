import Head from 'next/head';
import Page from '@/components/ui/Page/Page';
import CreateCoin from '@/forge/CreateCoin';
import { content } from '@/content';

/**
 * Create page (FREE ZONE). The site's normal page frame (header, body, footer) around a heading,
 * the short "before you launch" notes and the FORGE coin creation form. The notes come first in
 * the page so that phones show them above the form (compact); wide screens put them in a side
 * column (`launchpad-create-layout` in src/theme/theme.css).
 */
export default function CreatePoolPage() {
  return (
    <Page>
      <Head>
        <title>{`${content.strings.createCoin} - ${content.name}`}</title>
        <meta name="description" content={content.tagline} />
      </Head>

      <main className="launchpad-create">
        <header className="launchpad-create-heading">
          <p className="launchpad-eyebrow">{content.strings.createEyebrow}</p>
          <h1>{content.strings.createCoin}</h1>
          <p>{content.strings.createIntro}</p>
        </header>
        <div className="launchpad-create-layout">
          <aside className="launchpad-create-notes" aria-labelledby="launchpad-create-notes-title">
            <h2 id="launchpad-create-notes-title">{content.create.notesTitle}</h2>
            <ol>
              {content.create.notes.map((note) => (
                <li key={note.title}>
                  <span className="launchpad-create-note-title">{note.title}</span>
                  <span>{note.body}</span>
                </li>
              ))}
            </ol>
          </aside>
          <div className="launchpad-create-panel">
            <CreateCoin />
          </div>
        </div>
      </main>
    </Page>
  );
}
