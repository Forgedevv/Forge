import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  CREATE_FLOW,
  MODIFY_FLOW,
  JobStatus,
  failedStageForStatus,
  flowForJobType,
  isActiveJobStatus,
} from './jobs.js';
import { JOB_STATUS_LABELS } from './web-client.js';

describe('job flows', () => {
  it('create flow follows the documented order', () => {
    expect(CREATE_FLOW).toEqual([
      'spec_ready',
      'paid',
      'building',
      'preview_ready',
      'approved',
      'onchain_setup',
      'awaiting_owner_signature',
      'owner_signed',
      'deploying',
      'live',
    ]);
  });

  it('modify flow skips the on-chain steps', () => {
    expect(MODIFY_FLOW).toEqual(['spec_ready', 'paid', 'building', 'preview_ready', 'approved', 'deploying', 'live']);
    expect(flowForJobType('modify_launchpad')).toBe(MODIFY_FLOW);
    expect(flowForJobType('create_launchpad')).toBe(CREATE_FLOW);
  });

  it('flows only contain valid statuses', () => {
    for (const s of [...CREATE_FLOW, ...MODIFY_FLOW, ...ACTIVE_JOB_STATUSES]) {
      expect(JobStatus.safeParse(s).success).toBe(true);
    }
  });
});

describe('failedStageForStatus', () => {
  it('maps active statuses to their stage', () => {
    expect(failedStageForStatus('building')).toBe('build');
    expect(failedStageForStatus('onchain_setup')).toBe('onchain');
    expect(failedStageForStatus('deploying')).toBe('deploy');
  });

  it('returns null for non-active statuses', () => {
    for (const s of JobStatus.options) {
      if (!isActiveJobStatus(s)) expect(failedStageForStatus(s)).toBeNull();
    }
  });

  it('isActiveJobStatus matches ACTIVE_JOB_STATUSES', () => {
    expect(JobStatus.options.filter(isActiveJobStatus)).toEqual(['building', 'onchain_setup', 'deploying']);
  });
});

describe('JOB_STATUS_LABELS', () => {
  it('has a non-empty label for every status and nothing else', () => {
    expect(Object.keys(JOB_STATUS_LABELS).sort()).toEqual([...JobStatus.options].sort());
    for (const s of JobStatus.options) expect(JOB_STATUS_LABELS[s].length).toBeGreaterThan(0);
  });

  it('uses the agreed English labels', () => {
    expect(JOB_STATUS_LABELS.onchain_setup).toBe('Connecting to Meteora');
    expect(JOB_STATUS_LABELS.awaiting_owner_signature).toBe('Your turn to sign the launch');
    expect(JOB_STATUS_LABELS.failed).toBe('Problem');
  });
});
