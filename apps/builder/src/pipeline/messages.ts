/**
 * Client-visible `job_events` lines of the pipeline steps (shown in the chat in real time). Short,
 * friendly, no internal detail. The worker adds the start and completion lines of each step.
 */
export const STEP_EVENTS = {
  createRepo: 'Creating your repo',
  openRepo: 'Opening your launchpad repo',
  codeDesign: 'Coding the design',
  applyChanges: 'Applying your changes',
  checkChanges: 'Checking the changes',
  buildSite: 'Building your site',
  publishPreview: 'Publishing your preview',
  scanBlocked: 'The changes did not pass our safety checks',
  createConfigs: 'Creating your launchpad configuration on-chain',
  prepareLaunch: 'Preparing your launch transaction',
  release: 'Publishing your launchpad',
  connectDomain: 'Connecting your domain',
  live: (domain: string) => `Your launchpad is live at https://${domain}`,
} as const;
