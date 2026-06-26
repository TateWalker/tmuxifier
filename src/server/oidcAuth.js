import { createHash, randomBytes } from 'node:crypto';

export function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomState() {
  return base64url(randomBytes(16));
}

// Fetch the OIDC discovery document and return the authorization and token endpoints.
export async function fetchDiscovery(issuerUrl, fetchImpl = fetch) {
  const url = `${String(issuerUrl).replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new Error(`OIDC discovery fetch failed for ${url}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`OIDC discovery returned HTTP ${res.status} for ${url}`);
  let doc;
  try {
    doc = await res.json();
  } catch {
    throw new Error(`OIDC discovery response from ${url} is not valid JSON`);
  }
  const missing = ['authorization_endpoint', 'token_endpoint'].filter((k) => !doc[k]);
  if (missing.length) throw new Error(`OIDC discovery document missing fields: ${missing.join(', ')} (from ${url})`);
  return { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint };
}

function decodeIdTokenEmail(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return { email: payload.email, emailVerified: payload.email_verified === true || payload.email_verified === 'true' };
}

// Generic OIDC authorization-code + PKCE client. Endpoints are discovered lazily
// from the issuer's well-known configuration document and cached in memory.
export function createOidcAuth({
  issuerUrl,
  clientId,
  clientSecret,
  redirectUri,
  allowedEmails = [],
  skipEmailVerified = false,
  fetchImpl = fetch,
}) {
  const allow = new Set(allowedEmails.map((e) => String(e).toLowerCase()));
  let endpointsPromise = null;

  function endpoints() {
    if (!endpointsPromise) endpointsPromise = fetchDiscovery(issuerUrl, fetchImpl);
    return endpointsPromise;
  }

  return {
    async authorizationUrl({ state, codeChallenge, prompt } = {}) {
      const { authorizationEndpoint } = await endpoints();
      const u = new URL(authorizationEndpoint);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email');
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
      if (prompt) u.searchParams.set('prompt', prompt);
      return u.toString();
    },
    async exchangeCodeForEmail({ code, codeVerifier, redirectUri: redirectUriOverride }) {
      const { tokenEndpoint } = await endpoints();
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUriOverride ?? redirectUri,
      });
      const res = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
      const data = await res.json();
      if (!data.id_token) throw new Error('no id_token in token response');
      const { email, emailVerified } = decodeIdTokenEmail(data.id_token);
      if (!skipEmailVerified && !emailVerified) return { email, emailVerified: false };
      return { email, emailVerified: skipEmailVerified ? true : emailVerified };
    },
    isAllowed(email) {
      return typeof email === 'string' && allow.has(email.toLowerCase());
    },
  };
}

// Backward-compatible alias so existing code that imports createGoogleAuth still works.
export function createGoogleAuth(opts) {
  return createOidcAuth({
    ...opts,
    issuerUrl: opts.issuerUrl ?? 'https://accounts.google.com',
  });
}
