export const launchCopy = {
  eyebrow: 'LAUNCH YOUR COIN',
  title: 'The first spark is yours.',
  preparing: 'Preparing your launch transaction…',
  explanation:
    'This transaction creates your launchpad coin and makes the first buy shown below. You receive the tokens in the owner wallet.',
  firstBuy: 'Your first buy',
  network: 'Fees and account deposits',
  networkHint: 'Network fee, account rents, metadata and pool creation fees.',
  total: 'Total from your wallet',
  balanceNeeded: 'Balance needed in your wallet',
  simulationFailed: 'This launch could not be simulated.',
  simulationFailedBody:
    'A simulation of this exact transaction failed, so it may fail on-chain. The fees and deposits shown are a minimum.',
  simulationUnavailable: 'The amounts could not be checked.',
  simulationUnavailableBody:
    'No simulation of this exact transaction was available, so the fees and deposits shown are a minimum.',
  acknowledge: 'I understand and want to sign anyway.',
  owner: 'Owner wallet',
  connected: 'Connected wallet',
  sign: 'Sign and launch',
  wrong: 'Connect the owner wallet to launch this coin.',
  switch: 'Switch wallet',
  confirmed: 'Your launch is confirmed.',
  track: 'Back to tracking',
  retry: 'Retry the same launch transaction',
  retryBody: 'The launch transaction remains valid. You can try sending it again.',
  retrySigned:
    'Your signed launch is kept: retrying sends the same transaction again, without a new signature.',
} as const;
