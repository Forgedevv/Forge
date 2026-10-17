import { describe, expect, it } from 'vitest';
import { chatCopy } from './chat';
import { common } from './common';
import { dashboardCopy } from './dashboard';
import { detailCopy } from './detail';
import { faqCopy } from './faq';
import { gatingCopy } from './gating';
import { jobCopy } from './job';
import { launchCopy } from './launch';
import { paymentCopy } from './payment';
import { sessionCopy } from './session';
import { termsCopy } from './terms';

/** Every string of a copy module (functions and nested objects included). */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') return [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

// The development state gallery (gallery.ts) keeps the screen codes: it is not shown to clients.
const CLIENT_COPY = {
  chatCopy,
  common,
  dashboardCopy,
  detailCopy,
  faqCopy,
  gatingCopy,
  jobCopy,
  launchCopy,
  paymentCopy,
  sessionCopy,
  termsCopy,
};

describe('client-visible copy', () => {
  it.each(Object.entries(CLIENT_COPY))('%s shows no internal screen code', (_name, copy) => {
    for (const text of strings(copy)) expect(text).not.toMatch(/\bA\d{1,2}\s*[/·]/);
  });

  it('gives each information page its own eyebrow', () => {
    expect(faqCopy.eyebrow).not.toBe(termsCopy.eyebrow);
  });
});
