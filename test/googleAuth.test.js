import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createGoogleAuth, createOidcAuth, fetchDiscovery, pkcePair, randomState, base64url } from '../src/server/oidcAuth.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function makeDiscoveryFetch(authEndpoint, tokenEndpoint) {
  return async (url) => {
    if (url.includes('/.well-known/openid-configuration')) {
      return { ok: true, json: async () => ({ authorization_endpoint: authEndpoint, token_endpoint: tokenEndpoint }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function makeIdToken(payload) {
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.sig`;
}

test('pkcePair challenge is the S256 hash of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  const expected = base64url(createHash('sha256').update(verifier).digest());
  expect(challenge).toBe(expected);
  expect(randomState()).not.toBe(randomState());
});

test('fetchDiscovery returns endpoints from the discovery document', async () => {
  const fetchImpl = makeDiscoveryFetch(GOOGLE_AUTH, GOOGLE_TOKEN);
  const result = await fetchDiscovery('https://accounts.google.com', fetchImpl);
  expect(result.authorizationEndpoint).toBe(GOOGLE_AUTH);
  expect(result.tokenEndpoint).toBe(GOOGLE_TOKEN);
});

test('fetchDiscovery throws on fetch error', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await expect(fetchDiscovery('https://sso.example.com', fetchImpl)).rejects.toThrow(/network down/);
});

test('fetchDiscovery throws on non-OK status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  await expect(fetchDiscovery('https://sso.example.com', fetchImpl)).rejects.toThrow(/404/);
});

test('fetchDiscovery throws when required fields are missing', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ authorization_endpoint: 'https://a' }) });
  await expect(fetchDiscovery('https://sso.example.com', fetchImpl)).rejects.toThrow(/token_endpoint/);
});

test('authorizationUrl carries the OIDC + PKCE params', async () => {
  const fetchImpl = makeDiscoveryFetch(GOOGLE_AUTH, GOOGLE_TOKEN);
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  const u = new URL(await g.authorizationUrl({ state: 'ST', codeChallenge: 'CH' }));
  expect(u.origin + u.pathname).toBe(GOOGLE_AUTH);
  expect(u.searchParams.get('client_id')).toBe('cid');
  expect(u.searchParams.get('redirect_uri')).toBe('https://x/cb');
  expect(u.searchParams.get('response_type')).toBe('code');
  expect(u.searchParams.get('scope')).toBe('openid email');
  expect(u.searchParams.get('state')).toBe('ST');
  expect(u.searchParams.get('code_challenge')).toBe('CH');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
});

test('authorizationUrl supports prompt parameter', async () => {
  const fetchImpl = makeDiscoveryFetch(GOOGLE_AUTH, GOOGLE_TOKEN);
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  const u = new URL(await g.authorizationUrl({ state: 'ST', codeChallenge: 'CH', prompt: 'none' }));
  expect(u.searchParams.get('prompt')).toBe('none');
});

test('authorizationUrl omits prompt when not provided', async () => {
  const fetchImpl = makeDiscoveryFetch(GOOGLE_AUTH, GOOGLE_TOKEN);
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  const u = new URL(await g.authorizationUrl({ state: 'ST', codeChallenge: 'CH' }));
  expect(u.searchParams.has('prompt')).toBe(false);
});

test('exchangeCodeForEmail posts the code+verifier and decodes the id_token', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/.well-known/')) {
      return { ok: true, json: async () => ({ authorization_endpoint: GOOGLE_AUTH, token_endpoint: GOOGLE_TOKEN }) };
    }
    captured = { url, opts };
    return { ok: true, json: async () => ({ id_token: makeIdToken({ email: 'Alice@Example.com', email_verified: true }) }) };
  };
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  const r = await g.exchangeCodeForEmail({ code: 'abc', codeVerifier: 'ver' });
  expect(r).toEqual({ email: 'Alice@Example.com', emailVerified: true });
  expect(captured.url).toBe(GOOGLE_TOKEN);
  const body = new URLSearchParams(captured.opts.body);
  expect(body.get('code')).toBe('abc');
  expect(body.get('code_verifier')).toBe('ver');
  expect(body.get('grant_type')).toBe('authorization_code');
  expect(body.get('client_secret')).toBe('sec');
});

test('exchangeCodeForEmail accepts redirectUri override', async () => {
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/.well-known/')) return { ok: true, json: async () => ({ authorization_endpoint: GOOGLE_AUTH, token_endpoint: GOOGLE_TOKEN }) };
    capturedBody = new URLSearchParams(opts.body);
    return { ok: true, json: async () => ({ id_token: makeIdToken({ email: 'a@b.com', email_verified: true }) }) };
  };
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  await g.exchangeCodeForEmail({ code: 'x', codeVerifier: 'y', redirectUri: 'https://x/silent-callback' });
  expect(capturedBody.get('redirect_uri')).toBe('https://x/silent-callback');
});

test('exchangeCodeForEmail throws on a non-OK token response', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/.well-known/')) return { ok: true, json: async () => ({ authorization_endpoint: GOOGLE_AUTH, token_endpoint: GOOGLE_TOKEN }) };
    return { ok: false, status: 400, json: async () => ({}) };
  };
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  await expect(g.exchangeCodeForEmail({ code: 'x', codeVerifier: 'y' })).rejects.toThrow();
});

test('exchangeCodeForEmail returns emailVerified:false for unverified email', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/.well-known/')) return { ok: true, json: async () => ({ authorization_endpoint: GOOGLE_AUTH, token_endpoint: GOOGLE_TOKEN }) };
    return { ok: true, json: async () => ({ id_token: makeIdToken({ email: 'a@b.com', email_verified: false }) }) };
  };
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  const r = await g.exchangeCodeForEmail({ code: 'x', codeVerifier: 'y' });
  expect(r.emailVerified).toBe(false);
});

test('exchangeCodeForEmail accepts unverified email when skipEmailVerified=true', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/.well-known/')) return { ok: true, json: async () => ({ authorization_endpoint: GOOGLE_AUTH, token_endpoint: GOOGLE_TOKEN }) };
    return { ok: true, json: async () => ({ id_token: makeIdToken({ email: 'a@b.com' }) }) };
  };
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: [], skipEmailVerified: true, fetchImpl });
  const r = await g.exchangeCodeForEmail({ code: 'x', codeVerifier: 'y' });
  expect(r.emailVerified).toBe(true);
});

test('isAllowed is case-insensitive and rejects unlisted addresses', () => {
  const g = createOidcAuth({ issuerUrl: 'https://accounts.google.com', clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: ['alice@example.com'] });
  expect(g.isAllowed('ALICE@Example.com')).toBe(true);
  expect(g.isAllowed('bob@example.com')).toBe(false);
  expect(g.isAllowed(undefined)).toBe(false);
});

test('createGoogleAuth backward-compat shim works with discovery', async () => {
  const fetchImpl = makeDiscoveryFetch(GOOGLE_AUTH, GOOGLE_TOKEN);
  const g = createGoogleAuth({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: ['a@b.com'], fetchImpl });
  const url = await g.authorizationUrl({ state: 'ST', codeChallenge: 'CH' });
  expect(url).toContain(GOOGLE_AUTH);
});
