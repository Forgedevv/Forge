import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SupportBlock,
  SupportLinks,
  readSupportContact,
  supportEmail,
  supportMailto,
  telegramUrl,
  xUrl,
} from './support';
import { ErrorNotice } from './components';
import { FaqScreen } from './documents';
import { supportCopy as copy } from './content/support';

const JOB = '8d3c1f0e-6a52-4f07-9a7b-2b1d4c9e0f11';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function contact(telegram?: string, email?: string, x?: string) {
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_X_URL', x ?? '');
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_TELEGRAM_URL', telegram ?? '');
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', email ?? '');
}

describe('support contact configuration', () => {
  it('accepts only https Telegram links with a path', () => {
    expect(telegramUrl('https://t.me/forge_support')).toBe('https://t.me/forge_support');
    expect(telegramUrl(' https://telegram.me/forge ')).toBe('https://telegram.me/forge');
    for (const bad of [
      undefined,
      '',
      'http://t.me/forge',
      'https://t.me/',
      'https://t.me.evil.example/forge',
      'https://evil.example/t.me/forge',
      'https://user:pass@t.me/forge',
      'https://t.me:8443/forge',
      'javascript:alert(1)',
      'forge_support',
    ]) {
      expect(telegramUrl(bad)).toBeNull();
    }
  });

  it('accepts only https X profile links, normalised to x.com', () => {
    expect(xUrl('https://x.com/forge_support')).toBe('https://x.com/forge_support');
    expect(xUrl(' https://twitter.com/Forge ')).toBe('https://x.com/Forge');
    expect(xUrl('https://www.x.com/forge/')).toBe('https://x.com/forge');
    expect(xUrl('https://www.twitter.com/forge?s=21')).toBe('https://x.com/forge');
    for (const bad of [
      undefined,
      '',
      'http://x.com/forge',
      'https://x.com/',
      'https://x.com/forge/status/1',
      'https://x.com/forge-support',
      'https://x.com/a_handle_that_is_too_long',
      'https://x.com.evil.example/forge',
      'https://evil.example/x.com/forge',
      'https://user:pass@x.com/forge',
      'https://x.com:8443/forge',
      'https://t.me/forge',
      'javascript:alert(1)',
      '@forge',
      'forge',
    ]) {
      expect(xUrl(bad)).toBeNull();
    }
  });

  it('accepts only plain email addresses', () => {
    expect(supportEmail('support@forge.example')).toBe('support@forge.example');
    expect(supportEmail(' help+web@mail.forge.example ')).toBe('help+web@mail.forge.example');
    for (const bad of [
      undefined,
      '',
      'support',
      'support@forge',
      'a b@forge.example',
      'support@forge.example?cc=x@y.example',
      'support@forge.example&body=x',
      '<support@forge.example>',
      'mailto:support@forge.example',
    ]) {
      expect(supportEmail(bad)).toBeNull();
    }
  });

  it('reads the public variables, an invalid one counting as unset', () => {
    contact('https://t.me/forge_support', 'not-an-email', 'https://twitter.com/forge');
    expect(readSupportContact()).toEqual({
      x: 'https://x.com/forge',
      telegram: 'https://t.me/forge_support',
      email: null,
    });
    contact(undefined, undefined, 'https://x.com/forge/status/1');
    expect(readSupportContact()).toEqual({ x: null, telegram: null, email: null });
  });

  it('puts the reference and the context in the email', () => {
    const href = supportMailto('support@forge.example', {
      reference: JOB,
      context: ['Transaction signature: 5xY'],
    });
    const url = new URL(href);
    expect(url.protocol).toBe('mailto:');
    expect(url.pathname).toBe('support@forge.example');
    expect(url.searchParams.get('subject')).toBe(`FORGE support (${JOB})`);
    expect(url.searchParams.get('body')).toContain(`Reference: ${JOB}`);
    expect(url.searchParams.get('body')).toContain('Transaction signature: 5xY');
  });
});

describe('Contact us block', () => {
  it('falls back to the help page and the invite channel when no contact is set', () => {
    contact();
    render(<SupportBlock reference={JOB} />);
    const block = screen.getByRole('region', { name: copy.title });
    expect(block).toHaveTextContent(copy.fallback);
    expect(within(block).getByRole('link', { name: copy.help })).toHaveAttribute(
      'href',
      '/faq#support',
    );
    expect(within(block).getByText(JOB)).toBeInTheDocument();
    expect(within(block).queryByRole('link', { name: /Telegram/ })).not.toBeInTheDocument();
    expect(within(block).queryByRole('link', { name: new RegExp(copy.x) })).not.toBeInTheDocument();
  });

  it('shows the X channel alone when only it is set', () => {
    contact(undefined, undefined, 'https://x.com/forge_support');
    render(<SupportBlock reference={JOB} />);
    const link = screen.getByRole('link', { name: new RegExp(copy.x) });
    expect(link).toHaveAttribute('href', 'https://x.com/forge_support');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /Telegram/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.help })).not.toBeInTheDocument();
    expect(screen.getByText(copy.body)).toBeInTheDocument();
  });

  it('lists X first when several channels are set', () => {
    contact('https://t.me/forge_support', 'support@forge.example', 'https://x.com/forge_support');
    render(<SupportBlock reference={JOB} />);
    const links = within(screen.getByRole('region', { name: copy.title })).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://x.com/forge_support',
      'https://t.me/forge_support',
      expect.stringMatching(/^mailto:support@forge\.example\?/),
    ]);
  });

  it('shows the Telegram channel alone when only it is set', () => {
    contact('https://t.me/forge_support');
    render(<SupportBlock reference={JOB} />);
    const link = screen.getByRole('link', { name: new RegExp(copy.telegram) });
    expect(link).toHaveAttribute('href', 'https://t.me/forge_support');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /Email/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.help })).not.toBeInTheDocument();
    expect(screen.getByText(copy.body)).toBeInTheDocument();
  });

  it('shows both channels, with the reference in the email subject', () => {
    contact('https://t.me/forge_support', 'support@forge.example');
    render(<SupportBlock reference={JOB} />);
    expect(screen.getByRole('link', { name: new RegExp(copy.telegram) })).toBeInTheDocument();
    const email = screen.getByRole('link', { name: /Email support@forge\.example/ });
    expect(email.getAttribute('href')).toContain(encodeURIComponent(JOB));
    expect(screen.getByRole('button', { name: /Copy reference/ })).toBeInTheDocument();
  });

  it('renders nothing for a notice that does not want the fallback', () => {
    contact();
    const { container } = render(<SupportLinks fallback={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('notice links put X first', () => {
    contact('https://t.me/forge_support', undefined, 'https://twitter.com/forge_support');
    render(<SupportLinks />);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', 'https://x.com/forge_support');
    expect(links[0]).toHaveTextContent(copy.xShort);
    expect(links[1]).toHaveAttribute('href', 'https://t.me/forge_support');
  });
});

describe('support where clients need it', () => {
  it('error notices link to the contact, else to the help page', () => {
    contact();
    const { unmount } = render(<ErrorNotice message="Something failed." />);
    expect(screen.getByRole('link', { name: copy.help })).toHaveAttribute('href', '/faq#support');
    unmount();
    contact(undefined, 'support@forge.example');
    render(<ErrorNotice message="Something failed." reference={JOB} />);
    expect(screen.getByRole('link', { name: /Email us/ }).getAttribute('href')).toMatch(
      /^mailto:support@forge\.example\?subject=/,
    );
  });

  it('the FAQ answers how to get an invite and how to reach the team', () => {
    contact('https://t.me/forge_support');
    render(<FaqScreen />);
    expect(screen.getByText('How do I get an invite?')).toBeInTheDocument();
    const support = document.getElementById('support')!;
    expect(support).toHaveTextContent('How do I contact the FORGE team?');
    expect(
      within(support).getByRole('link', { name: new RegExp(copy.telegram) }),
    ).toBeInTheDocument();
  });

  it('opens the question a link points to', () => {
    contact();
    window.history.replaceState(null, '', '/faq#support');
    render(<FaqScreen />);
    expect(document.getElementById('support')).toHaveAttribute('open');
    expect(document.getElementById('fees')).not.toHaveAttribute('open');
    window.history.replaceState(null, '', '/');
  });
});
