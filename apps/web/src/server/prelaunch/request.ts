import { cookies } from 'next/headers';
import { prelaunchActive, PREVIEW_COOKIE, type PrelaunchEnv } from './config';

/**
 * Whether the current request sees "Coming soon". Always reads the cookies, so every page using
 * it renders per request: a page prerendered at build time would miss a later change of
 * FORGE_PRELAUNCH.
 */
export async function prelaunchForRequest(env: PrelaunchEnv = process.env): Promise<boolean> {
  const store = await cookies();
  const cookie = store.get(`__Host-${PREVIEW_COOKIE}`)?.value ?? store.get(PREVIEW_COOKIE)?.value;
  return prelaunchActive(cookie, env);
}
