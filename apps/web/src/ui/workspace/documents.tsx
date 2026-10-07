'use client';
import { Heading } from './components';
import { faqCopy } from './content/faq';
import { termsCopy } from './content/terms';
export function FaqScreen() {
  return (
    <>
      <Heading eyebrow={faqCopy.eyebrow} title={faqCopy.title} />
      <div className="fw-faq">
        {faqCopy.questions.map(([id, question, answer]) => (
          <details key={id} id={id}>
            <summary>{question}</summary>
            <p>{answer}</p>
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
