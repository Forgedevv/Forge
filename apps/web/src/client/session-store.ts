import type { Session } from '@forge/shared';

const STORAGE_KEY = 'forge.session.wallet';

let current: Session | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const w = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (w) current = { wallet: w };
  } catch {
    // storage unavailable
  }
}

export function getSessionSnapshot(): Session | null {
  hydrate();
  return current;
}

export function getServerSessionSnapshot(): Session | null {
  return null;
}

export function subscribeSession(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function setSession(session: Session | null): void {
  hydrate();
  current = session;
  try {
    if (session) globalThis.localStorage?.setItem(STORAGE_KEY, session.wallet);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable
  }
  emit();
}

/** Called when any API request answers 401: the cookie session is gone. */
export function emitUnauthorized(): void {
  if (current) setSession(null);
}
