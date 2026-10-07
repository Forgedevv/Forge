import type {
  Job,
  JobEvent,
  LaunchpadDetail,
  LaunchpadSpec,
  LaunchpadSummary,
  OwnerTransactionSummary,
} from '@forge/shared';

// Deliberately non-chain identifiers. These fixtures cannot be mistaken for funded wallets.
export const mockWallet = 'demo:owner-wallet';
export const otherWallet = 'demo:other-wallet';
export const mockDate = '2026-10-07T10:00:00.000Z';
export const fullSpec: LaunchpadSpec = {
  version: 1,
  quote: 'SOL',
  ownerWallet: mockWallet,
  name: 'Orbit',
  slug: 'orbit',
  tradingFeeBps: 100,
  coinCreatorSharePct: 20,
  poolCreationFeeSol: 0.01,
  antiSniper: true,
  theme: {
    primaryColor: '#827bdf',
    accentColor: '#c3caff',
    darkMode: true,
    tagline: 'A home for your next orbit.',
    designNotes: 'Quiet midnight surfaces, orbital details, and generous typography.',
  },
  launchpadCoin: {
    name: 'Orbit',
    symbol: 'ORBT',
    description: 'The community coin of Orbit.',
    imageUrl: '/forge-coin.svg',
    firstBuySol: 0.2,
  },
};
export const fixtureJob: Job = {
  id: 'demo-job',
  launchpadId: 'demo-pad',
  type: 'create_launchpad',
  status: 'spec_ready',
  attempts: 1,
  failedStage: null,
  error: null,
  previewUrl: '/dev/preview',
  createdAt: mockDate,
  updatedAt: mockDate,
};
export const fixturePad: LaunchpadSummary = {
  id: 'demo-pad',
  name: 'Orbit',
  slug: 'orbit',
  siteUrl: '/dev/preview',
  status: 'live',
  coin: { name: 'Orbit', symbol: 'ORBT', mint: null, imageUrl: '/forge-coin.svg' },
  coinsCount: 18,
  claimablePartnerFeesLamports: '1285000000',
  includedModificationsLeft: 2,
  activeJobId: null,
};
export const fixturePads: LaunchpadSummary[] = [
  fixturePad,
  {
    ...fixturePad,
    id: 'demo-sleeping',
    name: 'Lunar',
    slug: 'lunar',
    status: 'sleeping',
    coinsCount: 7,
    claimablePartnerFeesLamports: '0',
    includedModificationsLeft: 1,
  },
  {
    ...fixturePad,
    id: 'demo-disabled',
    name: 'Comet',
    slug: 'comet',
    status: 'disabled',
    coinsCount: 4,
    claimablePartnerFeesLamports: '0',
    includedModificationsLeft: 0,
  },
];
export const ownerSummary: OwnerTransactionSummary = {
  coinName: 'Orbit',
  coinSymbol: 'ORBT',
  firstBuyLamports: '200000000',
  estimatedNetworkFeeLamports: '5000',
  ownerWallet: mockWallet,
};
export const eventMessages = {
  spec_ready: 'Blueprint confirmed. Your quote is ready.',
  paid: 'Payment received. Opening the workshop.',
  building: 'Creating your repository and shaping the design.',
  preview_ready: 'Your preview is ready to explore.',
  approved: 'Preview approved.',
  onchain_setup: 'Connecting the launchpad to Meteora.',
  awaiting_owner_signature: 'Ready for your launch signature.',
  owner_signed: 'Launch signature received.',
  deploying: 'Publishing your launchpad.',
  live: 'Your launchpad is live.',
  failed: 'The build could not finish. Preparing the next step.',
  refunded: 'The creation payment was refunded.',
} as const;
export function eventFor(job: Job, id: number): JobEvent {
  return { id, jobId: job.id, message: eventMessages[job.status], createdAt: job.updatedAt };
}
export function detailFor(pad: LaunchpadSummary, jobs: Job[]): LaunchpadDetail {
  return {
    ...pad,
    spec: { ...fullSpec, name: pad.name, slug: pad.slug },
    onchain: { launchpadConfig: null, launchpadCoinConfig: null, launchpadCoinMint: null },
    versions: [
      { jobId: 'demo-job', createdAt: mockDate, request: null, previewUrl: '/dev/preview' },
    ],
    jobs,
  };
}
export const mockChatCopy = {
  welcome:
    'Tell me about the launchpad you would like to create. What is its name and who is it for?',
  modificationWelcome:
    'What would you like to change? The design and content can evolve; on-chain settings stay final.',
  replies: [
    'Orbit is a great starting point. Next, describe your trading fees, the creators’ share, and the coin creation fee.',
    'The fee settings are in your blueprint. What colors, mood, and tagline would you like?',
    'The visual direction is taking shape. Tell me about your launchpad coin and its first buy.',
    'Your blueprint is complete. Review every detail in the summary, then confirm when you are ready.',
  ],
  modificationReply: 'Your change request is ready to review. Confirm the request to continue.',
  network: 'The connection dropped. Please retry your message.',
  fieldError: 'Add the coin symbol before confirming.',
  sampleRequest: 'Make the hero more spacious and use a softer violet accent.',
} as const;
