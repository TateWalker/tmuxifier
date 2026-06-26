## 1. Config layer

- [x] 1.1 Add `oidcIssuerUrl`, `oidcClientId`, `oidcClientSecret`, `oidcAllowedEmails`, `oidcButtonLabel`, `oidcSkipEmailVerified` keys to `loadConfig` in `src/server/config.js`
- [x] 1.2 Map legacy aliases (`TMUXIFIER_OAUTH_CLIENT_ID`, `TMUXIFIER_GOOGLE_CLIENT_ID`, `TMUXIFIER_OAUTH_CLIENT_SECRET`, `TMUXIFIER_GOOGLE_CLIENT_SECRET`) to new keys
- [x] 1.3 Normalize `authMode`: accept `'google'` and `'oauth'`; both produce `'oauth'` internally; auto-set `oidcIssuerUrl=https://accounts.google.com` when mode was `'google'` and no issuer URL is provided
- [x] 1.4 Update `validateConfig` to require `oidcIssuerUrl`, `oidcClientId`, `oidcClientSecret` in oauth mode (replace the old Google-specific checks)
- [x] 1.5 Update `.env.example` with the new `TMUXIFIER_OIDC_*` variables and a commented Authentik example block

## 2. OIDC auth module

- [x] 2.1 Create `src/server/oidcAuth.js` with `fetchDiscovery(issuerUrl, fetchImpl)` that fetches `<issuerUrl>/.well-known/openid-configuration` and returns `{ authorizationEndpoint, tokenEndpoint }`; throw a descriptive error if fetch fails or fields are missing
- [x] 2.2 Implement `createOidcAuth({ issuerUrl, clientId, clientSecret, redirectUri, allowedEmails, skipEmailVerified, fetchImpl })` that lazily calls `fetchDiscovery` and caches endpoints
- [x] 2.3 Implement `authorizationUrl({ state, codeChallenge, prompt })` — identical to current Google version but uses discovered endpoint; support optional `prompt` param for silent flow
- [x] 2.4 Implement `exchangeCodeForEmail({ code, codeVerifier })` using discovered `tokenEndpoint`; respect `skipEmailVerified` flag
- [x] 2.5 Keep `isAllowed(email)` logic unchanged (exact-match allowlist)
- [x] 2.6 Re-export `pkcePair`, `randomState`, `base64url` from `oidcAuth.js` (or keep them in a shared `oauthUtils.js`) so existing imports don't break during transition

## 3. Server route updates

- [x] 3.1 Update `src/server/server.js` to import from `oidcAuth.js` instead of `googleAuth.js`; rename internal `google` variable to `oidc`
- [x] 3.2 Register new routes `GET /api/auth/oauth/login` and `GET /api/auth/oauth/callback` (same logic as current Google routes, using `oidc` helper)
- [x] 3.3 Register `GET /api/auth/oauth/silent` — builds authorization URL with `prompt=none` and `redirect_uri` pointing to `/api/auth/oauth/silent-callback`; sets state cookie; redirects to provider
- [x] 3.4 Register `GET /api/auth/oauth/silent-callback` — same token exchange as regular callback; on success set session cookie and return a small HTML page that calls `window.parent.postMessage('authed', '*')` (or redirects if no parent); on error (`interaction_required`, `login_required`, etc.) return a page that calls `window.parent.postMessage('silent-failed', '*')`
- [x] 3.5 Add legacy redirect routes: `GET /api/auth/google/login` → `302 /api/auth/oauth/login`; `GET /api/auth/google/callback` → `302 /api/auth/oauth/callback?<qs>`
- [x] 3.6 Update `/api/auth/info` to return `{ mode: 'oauth' }` for all OAuth configs (remove `'google'` branch)
- [x] 3.7 Update `buildServer` signature: accept `oidcAuth` param (replacing `googleAuth`); keep `googleAuth` as a deprecated alias that is forwarded to `oidcAuth` for test backward-compat

## 4. Web client login page

- [x] 4.1 Update `src/web/main.ts` (or login UI code) to call `GET /api/auth/info` on load; when `mode === 'oauth'` show the OAuth login button
- [x] 4.2 Render the button label from a new `GET /api/auth/info` response field `buttonLabel` (server returns `oidcButtonLabel ?? 'OAuth'`); display as "Login with \<label\>"
- [x] 4.3 On login page load in oauth mode, inject a hidden `<iframe src="/api/auth/oauth/silent">` to attempt silent sign-in
- [x] 4.4 Listen for `postMessage` from the iframe: on `'authed'` reload the page (user is now signed in); on `'silent-failed'` remove the iframe and show the login button normally
- [x] 4.5 Add a short timeout (e.g. 5 s) after which, if no `postMessage` is received, treat as `'silent-failed'` (handles providers that don't respond to `prompt=none` at all)

## 5. Tests

- [x] 5.1 Write unit tests for `fetchDiscovery` in `oidcAuth.js`: success, fetch failure, missing fields
- [x] 5.2 Write unit tests for `createOidcAuth.authorizationUrl`: verifies query params including `prompt` support
- [x] 5.3 Write unit tests for `createOidcAuth.exchangeCodeForEmail`: success, token endpoint error, missing `id_token`, `email_verified` enforcement, `skipEmailVerified` flag
- [x] 5.4 Write unit tests for `loadConfig` covering new OIDC keys, legacy alias mapping, and `authMode` normalization
- [x] 5.5 Write integration tests for `/api/auth/oauth/login`, `/api/auth/oauth/callback` (success + error paths) using a stub OIDC server
- [x] 5.6 Write tests for `/api/auth/oauth/silent` and `/api/auth/oauth/silent-callback` (success, `interaction_required`, generic error)
- [x] 5.7 Write tests for legacy redirect routes `/api/auth/google/login` and `/api/auth/google/callback`
- [x] 5.8 Verify `/api/auth/info` returns `{ mode: 'oauth', buttonLabel: '...' }` in OAuth mode

## 6. Documentation

- [x] 6.1 Add a "Generic OAuth / OIDC" section to `README.md` with the required env vars table and a note that any OIDC provider is supported
- [x] 6.2 Add an Authentik-specific subsection to `README.md` with step-by-step: create an OAuth2/OIDC application in Authentik, set redirect URI, copy client ID/secret, configure `TMUXIFIER_OIDC_*` vars
- [x] 6.3 Update `docs/DEPLOY.md` OAuth section: replace Google-only instructions with generic OIDC instructions; add Authentik example; note `TMUXIFIER_OIDC_SKIP_EMAIL_VERIFIED` for providers that omit the claim
- [x] 6.4 Add deprecation note in `README.md` for `TMUXIFIER_GOOGLE_CLIENT_ID` / `TMUXIFIER_GOOGLE_CLIENT_SECRET` (accepted as aliases, will be removed in a future version)
- [x] 6.5 Update `.env.example` comments to reflect new variable names (covered by task 1.5 — verify docs match)
