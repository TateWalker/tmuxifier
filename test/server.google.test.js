import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createOidcAuth, base64url } from '../src/server/oidcAuth.js';

const FAKE_AUTH_ENDPOINT = 'https://sso.example.com/auth';
const FAKE_TOKEN_ENDPOINT = 'https://sso.example.com/token';

function makeIdToken(payload) {
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'none' })));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.sig`;
}

async function makeApp({ email = 'alice@example.com', emailVerified = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oauth-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    authMode: 'oauth', cookieSecret: 'test-secret', secureCookie: false,
    publicUrl: 'https://tmux.example.com',
    oidcIssuerUrl: 'https://sso.example.com', oidcClientId: 'cid', oidcClientSecret: 'csecret',
    allowedEmails: ['alice@example.com'],
    dataDir: dir, sshConfigPath: path.join(dir, 'nope'),
  };
  const fetchImpl = async (url) => {
    if (url.includes('/.well-known/')) {
      return { ok: true, json: async () => ({ authorization_endpoint: FAKE_AUTH_ENDPOINT, token_endpoint: FAKE_TOKEN_ENDPOINT }) };
    }
    return { ok: true, json: async () => ({ id_token: makeIdToken({ email, email_verified: emailVerified }) }) };
  };
  const oidcAuth = createOidcAuth({
    issuerUrl: config.oidcIssuerUrl,
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
    redirectUri: `${config.publicUrl}/api/auth/oauth/callback`,
    allowedEmails: config.allowedEmails,
    fetchImpl,
  });
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const statusChecker = { checkBox: async () => ({ reachable: true }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  return buildServer({ config, store, sessions, statusChecker, oidcAuth });
}

async function flow(app, { tamperState = false } = {}) {
  const login = await app.inject({ method: 'GET', url: '/api/auth/oauth/login' });
  const oauth = login.cookies.find((c) => c.name === 'tmuxifier_oauth');
  const sentState = new URL(login.headers.location).searchParams.get('state');
  const useState = tamperState ? 'WRONG' : sentState;
  const cb = await app.inject({
    method: 'GET',
    url: `/api/auth/oauth/callback?code=abc&state=${encodeURIComponent(useState)}`,
    headers: { cookie: `tmuxifier_oauth=${oauth.value}` },
  });
  return { login, oauth, cb };
}

let app;
beforeEach(async () => { app = await makeApp(); });

test('/api/auth/info reports oauth mode and /api/login is gone', async () => {
  const info = (await app.inject({ method: 'GET', url: '/api/auth/info' })).json();
  expect(info.mode).toBe('oauth');
  expect(info.buttonLabel).toBe('OAuth');
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'x' } });
  expect(login.statusCode).toBe(404);
});

test('login redirects to the OIDC provider and sets the signed oauth cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/login' });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toContain(FAKE_AUTH_ENDPOINT);
  expect(res.cookies.find((c) => c.name === 'tmuxifier_oauth')).toBeTruthy();
});

test('callback with valid state + allowed email sets the session cookie', async () => {
  const { cb } = await flow(app);
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toBe('/');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeTruthy();
});

test('callback with a mismatched state is rejected', async () => {
  const { cb } = await flow(app, { tamperState: true });
  expect(cb.headers.location).toBe('/?error=state');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeFalsy();
});

test('callback with a disallowed email is forbidden', async () => {
  app = await makeApp({ email: 'mallory@evil.com' });
  const { cb } = await flow(app);
  expect(cb.headers.location).toBe('/?error=forbidden');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeFalsy();
});

test('callback with an unverified email is forbidden', async () => {
  app = await makeApp({ emailVerified: false });
  const { cb } = await flow(app);
  expect(cb.headers.location).toBe('/?error=forbidden');
});

test('callback with no oauth cookie is rejected as state error', async () => {
  const cb = await app.inject({ method: 'GET', url: '/api/auth/oauth/callback?code=abc&state=ST' });
  expect(cb.headers.location).toBe('/?error=state');
});

test('legacy /api/auth/google/login redirects to /api/auth/oauth/login', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/google/login' });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe('/api/auth/oauth/login');
});

test('legacy /api/auth/google/callback redirects to /api/auth/oauth/callback preserving query string', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc&state=XYZ' });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe('/api/auth/oauth/callback?code=abc&state=XYZ');
});

test('silent-callback with provider error returns html with silent-failed message', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/silent-callback?error=interaction_required' });
  expect(res.headers['content-type']).toMatch(/text\/html/);
  expect(res.body).toContain('silent-failed');
});

test('silent-callback with valid auth sets session and returns authed html', async () => {
  const silent = await app.inject({ method: 'GET', url: '/api/auth/oauth/silent' });
  expect(silent.statusCode).toBe(302);
  const oauthCookie = silent.cookies.find((c) => c.name === 'tmuxifier_oauth');
  const sentState = new URL(silent.headers.location).searchParams.get('state');
  const cb = await app.inject({
    method: 'GET',
    url: `/api/auth/oauth/silent-callback?code=abc&state=${encodeURIComponent(sentState)}`,
    headers: { cookie: `tmuxifier_oauth=${oauthCookie.value}` },
  });
  expect(cb.headers['content-type']).toMatch(/text\/html/);
  expect(cb.body).toContain('authed');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeTruthy();
});
