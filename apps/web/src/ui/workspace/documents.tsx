'use client';
import { useEffect, useState } from 'react';
import { Heading } from './components';
import { SupportBlock, SupportLinks } from './support';
import { faqCopy } from './content/faq';
import { termsCopy } from './content/terms';
import { supportCopy } from './content/support';

/** The question a link points to (`/faq#support`), opened on arrival and on hash changes. */
function useLinkedQuestion(): string {
  const [hash, setHash] = useState('');
  useEffect(() => {
    const read = () => setHash(decodeURIComponent(window.location.hash.slice(1)));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView?.({ block: 'start' });
  }, [hash]);
  return hash;
}

export function FaqScreen() {
  const linked = useLinkedQuestion();
  return (
    <>
      <Heading eyebrow={faqCopy.eyebrow} title={faqCopy.title} />
      <div className="fw-faq">
        {faqCopy.questions.map(([id, question, answer]) => (
          // Keyed on the linked question so that arriving on `#id` opens it.
          <details key={`${id}:${linked === id}`} id={id} open={linked === id || undefined}>
            <summary>{question}</summary>
            <p>{answer}</p>
            {id === 'support' && <SupportBlock />}
            {id === 'invite' && (
              <p className="fw-faq-links">
                <SupportLinks subject={supportCopy.inviteSubject} />
              </p>
            )}
          </details>
        ))}
      </div>
    </>
  );
}
export function TermsScreen() {
  return (
    <>
      <Heading eyebrow={termsCopy.eyebrow} title={termsCopy.title} />
      <article className="fw-prose">
        {termsCopy.sections.map(([title, body]) => (
          <section key={title}>
            <h2>{title}</h2>
            <p>{body}</p>
          </section>
        ))}
      </article>
    </>
  );
}
