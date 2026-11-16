/**
 * "Sign in with OpenRouter". The user approves this app on OpenRouter's own page and comes back
 * with a one-time code, which is swapped for an API key that belongs to them. No password or key
 * is typed here, and nothing passes through a CanvasShutter server (there is none).
 * This is OpenRouter's PKCE flow: https://openrouter.ai/docs/guides/overview/auth/oauth
 */
const PENDING = 'ai.openrouter.pending';
const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

interface Pending { verifier: string; state: string; remember: boolean }

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The S256 challenge for a verifier: the base64url of its SHA-256 hash. */
export async function challengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Sends the browser to OpenRouter's approval page. The page comes back to this same address. */
export async function beginSignIn(remember: boolean): Promise<void> {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot sign in here (it needs a secure https page). Paste a key instead.');
  const pending: Pending = { verifier: randomToken(), state: randomToken(), remember };
  try { sessionStorage.setItem(PENDING, JSON.stringify(pending)); }
  catch { throw new Error('This browser is blocking storage for this page, so signing in cannot finish. Paste a key instead.'); }
  const url = new URL(AUTH_URL);
  url.searchParams.set('callback_url', location.origin + location.pathname);
  url.searchParams.set('code_challenge', await challengeFor(pending.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', pending.state);
  location.assign(url.toString());
}

/**
 * Call once when the page starts. If the user has just come back from OpenRouter, swaps the code
 * for their key and returns it; otherwise returns null. The code is removed from the address bar.
 */
export async function finishSignIn(): Promise<{ key: string; remember: boolean } | null> {
  let pending: Pending | null = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null'); } catch { /* treated as no sign-in under way */ }
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  // Only a code that answers a sign-in started in this tab is used; any other ?code= is left alone.
  if (!pending || typeof pending.verifier !== 'string' || !code) return null;
  try { sessionStorage.removeItem(PENDING); } catch { /* ignore */ }
  const returnedState = params.get('state');
  params.delete('code'); params.delete('state');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  if (returnedState !== null && returnedState !== pending.state) throw new Error('The sign-in answer did not match the request, so it was ignored. Please try again.');

  let res: Response;
  try {
    res = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
    });
  } catch { throw new Error('Could not reach OpenRouter to finish signing in. Check your connection and try again.'); }
  let body: { key?: unknown; error?: { message?: unknown } } | null = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok || typeof body?.key !== 'string' || !body.key) {
    const why = typeof body?.error?.message === 'string' ? ` (${body.error.message})` : '';
    throw new Error(`OpenRouter did not complete the sign-in${why}. Please try again.`);
  }
  return { key: body.key, remember: !!pending.remember };
}
