import { Uuid, type LaunchpadSpec, type SpecConfirmResponse } from '@forge/shared';
import { z } from 'zod';
import { checkOrigin, requireSession } from '@/server/auth';
import {
  CoinImageUnavailableError,
  getDefaultCoinImageRehoster,
  imageUnavailableMessage,
  type CoinImageRehoster,
} from '@/server/coin-images';
import { UploadConfigError } from '@/server/uploads/config';
import { StorageError } from '@/server/uploads/storage';
import { defaultChatDeps, type ChatDeps } from './handler';
import { apiError, readBoundedJson } from './http';
import { clientIp } from './rate-limit';
import { fieldErrorsMessage } from './spec-messages';
import { validateConfirmedSpec } from './spec-draft';
import { DRAFT_POLICY, StoreError } from './store';

/*
 * POST /api/spec/confirm `{ conversationId, spec }` -> `{ launchpadId, jobId }`.
 * Re-validates the spec (schema, bounds, extra rules), requires spec.ownerWallet to be the
 * session wallet and creates the draft launchpad plus its `create_launchpad` job in `spec_ready`.
 * Idempotent per conversation: confirming the same spec again returns the same ids.
 * Slug reservation (anti-squatting): see DRAFT_POLICY in store.ts.
 *
 * Before anything is written, the coin image and the logo are copied into FORGE's R2 bucket and
 * the stored spec keeps the bucket URLs (coin-images/rehost.ts). An image that cannot be copied
 * answers 422 IMAGE_UNAVAILABLE (the owner gives another URL in the chat) and creates nothing.
 */

const CONFIRM_PER_WINDOW = 20;
const CONFIRM_WINDOW_MS = 10 * 60_000;

/** Same shape as SpecConfirmRequest; the spec is validated separately for readable messages. */
const ConfirmBody = z.strictObject({ conversationId: Uuid, spec: z.unknown() });

export type SpecConfirmDeps = Pick<ChatDeps, 'store' | 'limiter' | 'gating'> & {
  images: () => CoinImageRehoster;
};

export function defaultSpecConfirmDeps(): SpecConfirmDeps {
  return { ...defaultChatDeps(), images: getDefaultCoinImageRehoster };
}

const UNAVAILABLE_MESSAGE = 'Could not confirm the launchpad right now. Please try again.';

/** The spec with its images in the bucket, or the error response (nothing written yet). */
async function rehostImages(
  deps: SpecConfirmDeps,
  spec: LaunchpadSpec,
): Promise<LaunchpadSpec | Response> {
  let rehosted: LaunchpadSpec;
  try {
    rehosted = await deps.images().rehost(spec);
  } catch (error) {
    if (error instanceof CoinImageUnavailableError) {
      return apiError(422, 'IMAGE_UNAVAILABLE', imageUnavailableMessage(error));
    }
    if (error instanceof UploadConfigError || error instanceof StorageError) {
      // Both messages name variables or an operation and an HTTP status, never a value.
      console.error(`[spec] coin image copy unavailable: ${error.message}`);
      return apiError(503, 'SERVER_ERROR', UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
  // The bucket URLs must pass the same rules as the owner's (e.g. R2_PUBLIC_URL with a port).
  const checked = validateConfirmedSpec(rehosted);
  if (!checked.ok) {
    console.error('[spec] coin image copy unavailable: R2_PUBLIC_URL is not a public https URL');
    return apiError(503, 'SERVER_ERROR', UNAVAILABLE_MESSAGE);
  }
  return checked.spec;
}

/** The wallet check runs on the raw body first so a wrong wallet is reported as such. */
const Envelope = z.object({
  conversationId: z.string(),
  spec: z.object({ ownerWallet: z.string() }).loose(),
});

export async function handleSpecConfirm(
  request: Request,
  deps: SpecConfirmDeps = defaultSpecConfirmDeps(),
): Promise<Response> {
  try {
    const forbidden = checkOrigin(request);
    if (forbidden) return forbidden;
    const session = requireSession(request);
    if (session instanceof Response) return session;

    const raw = await readBoundedJson(request);
    const envelope = Envelope.safeParse(raw);
    if (envelope.success && envelope.data.spec.ownerWallet !== session.wallet) {
      return apiError(
        403,
        'WRONG_WALLET',
        'This launchpad must be owned by the wallet you are signed in with.',
      );
    }

    const parsed = ConfirmBody.safeParse(raw);
    if (!parsed.success) return apiError(400, 'BAD_REQUEST', 'Invalid confirmation request.');
    const checked = validateConfirmedSpec(parsed.data.spec);
    if (!checked.ok) return apiError(400, 'BAD_REQUEST', fieldErrorsMessage(checked.errors));
    // Defense in depth: the schema above already compared the wallet on the raw body.
    if (checked.spec.ownerWallet !== session.wallet) {
      return apiError(
        403,
        'WRONG_WALLET',
        'This launchpad must be owned by the wallet you are signed in with.',
      );
    }

    const limit = await deps
      .limiter()
      .consume(
        `spec-confirm:${session.wallet}:${clientIp(request)}`,
        CONFIRM_PER_WINDOW,
        CONFIRM_WINDOW_MS,
      );
    if (!limit.allowed) {
      return apiError(
        429,
        'RATE_LIMITED',
        'Too many requests. Please wait a moment and try again.',
        {
          'Retry-After': String(limit.retryAfterSeconds),
        },
      );
    }

    const store = deps.store();
    if (await store.getFlag('signups_paused')) {
      return apiError(403, 'SIGNUPS_PAUSED', 'New signups are temporarily paused.');
    }
    const gate = await deps.gating(session.wallet);
    if (!gate.ok) {
      return apiError(
        403,
        'GATING_REQUIRED',
        'You need to hold more $FORGE to use the design assistant.',
      );
    }

    const spec = await rehostImages(deps, checked.spec);
    if (spec instanceof Response) return spec;

    const outcome = await store.confirmSpec({
      wallet: session.wallet,
      conversationId: parsed.data.conversationId,
      spec,
    });
    switch (outcome.status) {
      case 'created':
      case 'existing': {
        const body: SpecConfirmResponse = {
          launchpadId: outcome.launchpadId,
          jobId: outcome.jobId,
        };
        return Response.json(body, {
          status: outcome.status === 'created' ? 201 : 200,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      case 'conversation_not_found':
        return apiError(404, 'NOT_FOUND', 'Conversation not found.');
      case 'slug_taken':
        return apiError(
          409,
          'CONFLICT',
          'That subdomain is already taken. Pick another one in the chat.',
        );
      case 'too_many_drafts':
        return apiError(
          409,
          'CONFLICT',
          `You already have ${DRAFT_POLICY.maxUnpaidDrafts} unpaid launchpad drafts. Pay for one of them, or try again once one is a day old.`,
        );
      case 'draft_released':
        return apiError(
          409,
          'CONFLICT',
          'This draft expired unpaid and its subdomain was released. Please start a new conversation.',
        );
      case 'conflict':
        return apiError(
          409,
          'CONFLICT',
          'This conversation was already confirmed with a different spec.',
        );
    }
  } catch (error) {
    console.error(`[spec] ${error instanceof StoreError ? error.message : 'unexpected error'}`);
    return apiError(503, 'SERVER_ERROR', UNAVAILABLE_MESSAGE);
  }
}
