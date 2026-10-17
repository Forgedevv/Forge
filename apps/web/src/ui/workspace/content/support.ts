export const supportCopy = {
  title: 'Contact us',
  body: 'The FORGE team can help. Quote the reference below so we find your launchpad right away.',
  bodyNoReference: 'The FORGE team can help.',
  telegram: 'Message us on Telegram',
  email: (address: string) => `Email ${address}`,
  link: 'Contact us',
  telegramShort: 'Contact us on Telegram',
  emailShort: 'Email us',
  emailSubject: 'FORGE support',
  inviteSubject: 'FORGE invite request',
  emailReference: 'Reference',
  /** No contact is configured: the help page and the channel of the invite. */
  fallback:
    'Reach the FORGE team through the channel where you received your invite, and quote the reference below.',
  fallbackNoReference: 'Reach the FORGE team through the channel where you received your invite.',
  help: 'Get help',
  reference: 'Reference to quote',
  details: 'Details for support',
  copy: 'Copy',
  copied: 'Reference copied',
  copyFailed: 'Copy unavailable. Select the reference above.',
} as const;
