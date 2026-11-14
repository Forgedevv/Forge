import { serializeCookie } from '../auth/cookies';
import {
  isPreviewKey,
  previewKey,
  previewToken,
  PREVIEW_COOKIE,
  PREVIEW_MAX_AGE_SECONDS,
  type PrelaunchEnv,
} from './config';

/*
 * GET /api/preview?key=<FORGE_PRELAUNCH_PREVIEW_KEY>  sets the preview cookie, then goes home.
 * GET /api/preview?off                                clears it.
 * A wrong or missing key just goes home, without a cookie and without saying why. Without a
 * configured key the route does not exist (404).
 */
export function handlePreview(request: Request, env: PrelaunchEnv = process.env): Response {
  const key = previewKey(env);
  if (key === null)
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const params = new URL(request.url).searchParams;
  const headers = new Headers({
    location: '/',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  if (params.has('off')) {
    headers.append('set-cookie', serializeCookie(request, PREVIEW_COOKIE, '', 0));
  } else if (isPreviewKey(params.get('key') ?? '', env)) {
    headers.append(
      'set-cookie',
      serializeCookie(request, PREVIEW_COOKIE, previewToken(key), PREVIEW_MAX_AGE_SECONDS),
    );
  }
  return new Response(null, { status: 303, headers });
}
