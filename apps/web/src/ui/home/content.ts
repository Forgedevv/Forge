export const homeContent = {
  brand: 'FORGE',
  title: 'FORGE — Build your corner.',
  description:
    'Describe your idea. Build your own Solana launchpad with FORGE. Your world, your community, your rules.',
  navigation: 'Explore the FORGE journey',
  menu: 'The details',
  close: 'Close',
  connect: 'Connect my wallet',
  create: 'Create my launchpad',
  dashboard: 'My dashboard',
  disconnect: 'Disconnect',
  scroll: 'SCROLL TO EXPLORE',
  next: 'Next chapter',
  previous: 'Previous chapter',
  restart: 'Back to the beginning',
  skip: 'Skip intro',
  loading: 'IGNITION SEQUENCE',
  ignition: 'A LITTLE SPARK. AN ENTIRE WORLD.',
  index: 'CHAPTER',
  motionOn: 'Pause animation',
  motionOff: 'Resume animation',
  simpler: 'Use the simple view',
  immersive: 'Return to the experience',
  fallback: 'The simple view is active. Explore every chapter below.',
  paused: 'Creation is paused, try again later.',
  copyright: '© 2026 FORGE',
  platform: 'BUILT FOR SOLANA',
  faq: 'FAQ',
  terms: 'Terms',
  chapterNames: [
    'The spark',
    'Your world',
    'The workshop',
    'Built together',
    'Your rules',
    'Liftoff',
  ],
  chapters: [
    {
      eyebrow: '01 / THE SPARK',
      title: 'Your own corner\nof the chain.',
      subtitle: 'A home for your community.',
      description: 'A Solana launchpad built around your community.',
    },
    {
      eyebrow: '02 / YOUR WORLD',
      title: 'Give it a look\nthat feels like you.',
      subtitle: 'Name. Color. Character.',
      description: 'Your identity runs through every page.',
    },
    {
      eyebrow: '03 / THE WORKSHOP',
      title: 'From idea\nto launchpad.',
      subtitle: 'Build. Preview. Launch.',
      description: 'See the site before it goes live.',
    },
    {
      eyebrow: '04 / BUILT TOGETHER',
      title: 'Bring your\npeople together.',
      subtitle: 'A shared place to create and trade.',
      description: 'Your community owns the culture.',
    },
    {
      eyebrow: '05 / YOUR RULES',
      title: 'Set the rules\nfor your world.',
      subtitle: 'Your site. Your settings.',
      description: 'Manage the launch from your dashboard.',
    },
    {
      eyebrow: '06 / LIFTOFF',
      title: 'Make it live.',
      subtitle: 'Start with one idea.',
      description: 'One launchpad. Two changes included.',
    },
  ],
  scenery: {
    hero: 'FORGE',
    repetition: 'YOUR WORLD. YOUR RULES.',
    glass: 'MAKE IT YOURS',
    buildWords: ['BUILD', 'MAKE', 'LAUNCH'],
    orbit: 'IDEAS IN. WORLDS OUT. ',
    screenNames: [
      'ORBIT',
      'EMBER',
      'AFTERHOURS',
      'GOOD COMPANY',
      'PLAYGROUND',
      'ODD WORLD',
      'DAY ONE',
      'YOUR NEXT IDEA',
    ],
    screenLabel: 'EXAMPLE LAUNCHPAD',
    screenTabs: 'EXPLORE     NEW COINS     COMMUNITY',
    screenAction: 'CREATE A COIN',
    screenCoins: ['NOVA', 'SPARK', 'LUNA'],
  },
  manifesto: [
    ['You bring the spark.', 'We build the world.'],
    ['Your identity.', 'Your community.', 'Your own launchpad.'],
    ['Less waiting.', 'More making.', 'Let something good begin.'],
  ],
  details: {
    eyebrow: 'THE SHORT VERSION',
    title: 'Your idea.\nA real launchpad.',
    intro: 'FORGE turns a conversation into a Solana launchpad built around your community.',
    steps: [
      {
        title: 'Describe it',
        body: 'Tell the builder your name, style, token details, and fee settings.',
      },
      {
        title: 'Watch it take shape',
        body: 'Confirm your specification and follow the build as it progresses.',
      },
      {
        title: 'Make it yours',
        body: 'Explore your preview and approve the design before it goes live.',
      },
      {
        title: 'Launch your world',
        body: 'Review and sign the launch in your wallet, then manage your site from your dashboard.',
      },
    ],
    priceLabel: 'ONE CREATION',
    price: '$33',
    priceUnit: 'paid in SOL',
    priceDescription:
      'Two changes included. Additional changes are $5.50 each. Your initial coin buy and network fees are separate and shown before signing.',
    exampleTitle: 'Meet Ember',
    exampleDescription:
      'An illustrative launchpad identity. A new home for a community of makers. This is a design example, not a live trading site.',
    exampleBadge: 'DESIGN EXAMPLE',
    faqTitle: 'A few good questions.',
    questions: [
      {
        question: 'Do I need to write code?',
        answer:
          'No. Describe the launchpad you want in the design chat. You review the specification and approve a preview before launch.',
      },
      {
        question: 'How do I claim my fees?',
        answer:
          'Your dashboard shows the partner fees available for each launchpad. Claiming them requires a transaction in your wallet.',
      },
      {
        question: 'What if the build fails?',
        answer:
          'FORGE retries a failed build once. If both build attempts fail, the creation payment is refunded automatically. Failures after approval are handled by the team.',
      },
      {
        question: 'Why is my coin not visible yet?',
        answer:
          'The launch must be confirmed before your coin is available. Check your job status for the next action or an error message.',
      },
      {
        question: 'Can I change the site later?',
        answer:
          'Two site changes are included, then each additional change is $5.50. On-chain fee settings and recipients are final.',
      },
      {
        question: 'What happens when my launchpad sleeps?',
        answer:
          'After 30 days without a trade, the launchpad enters sleep mode. You can request reactivation from your dashboard.',
      },
    ],
  },
  connection: {
    eyebrow: 'YOUR NEXT WORLD',
    title: 'The workshop is warming up.',
    description:
      'Wallet connection and launchpad creation are not available in this preview yet. Explore how FORGE works while we prepare for launch.',
    action: 'Explore how it works',
  },
  termsPage: {
    title: 'Before you launch.',
    label: 'PROVISIONAL PRODUCT INFORMATION',
    body: 'FORGE is in development. This preview does not accept payments, connect wallets, or create launchpads. Final terms will be published before the service opens.',
    note: 'Review all amounts and transaction details in your wallet before signing. On-chain settings are final. The product FAQ describes the planned build, approval, and refund process.',
    back: 'Back to FORGE',
  },
} as const;

/** Graphite, paper, brushed metal and copper. Shared with the workshop scene. */
export const palette = {
  ink: '#202426',
  night: '#292f32',
  plum: '#424e53',
  light: '#eae6dc',
  accent: '#b78970',
  lilac: '#d0cdbd',
  magenta: '#c99b7e',
  faint: '#384247',
  wire: '#8c9da1',
  backgrounds: ['#292f32', '#333e42', '#202426', '#2b3337', '#252c30', '#222a2e'],
  floor: 0x475459,
};
