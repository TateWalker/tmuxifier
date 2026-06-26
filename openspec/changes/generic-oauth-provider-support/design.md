## Context

Tmuxifier has a hand-rolled Google OIDC implementation in `src/server/googleAuth.js`. The authorization-code + PKCE flow is already correct and dependency-free; the only Google-specific parts are two hard-coded endpoint URLs (`AUTH_ENDPOINT`, `TOKEN_ENDPOINT`) and the `google` naming throughout `config.js` and `server.js`. Users running Authentik, Keycloak, Dex, or any other OIDC-compliant provider cannot currently use OAuth mode without patching source code.

The web login page has no OAuth button; users are navigated to the Google flow only via a direct URL or a separate mechanism.

## Goals / Non-Goals

**Goals:**
- Support any OIDC-compliant provider (Authentik, Keycloak, Okta, GitHub†, Google, etc.) via config only — no code changes per provider.
- Discover endpoints automatically from `<issuer>/.well-known/openid-configuration` (OIDC Discovery).
- Add a "Login with \<provider\>" button to the login page that initiates the OAuth flow.
- Attempt an automatic silent sign-in (`prompt=none`) on page load so users already logged in to their provider are signed in to Tmuxifier without clicking.
- Preserve full backward compatibility: existing `TMUXIFIER_OAUTH_CLIENT_ID` / `TMUXIFIER_GOOGLE_CLIENT_ID` env vars and `authMode=google` still work (Google is just a provider whose issuer URL is known).
- Update README and DEPLOY docs with a generic setup section and an Authentik example.

**Non-Goals:**
- Multi-provider (multiple OAuth buttons) — single configured provider only.
- Refresh token handling or long-lived OAuth sessions — session lifetime is still the Tmuxifier cookie.
- Offline access or resource-server scopes.
- JWKS signature verification of the id_token — the token is fetched server-to-server from the provider's token endpoint over TLS, which is the same trust model as the current Google implementation.

## Decisions

### 1. OIDC Discovery instead of hard-coded endpoints

**Decision**: Fetch `<TMUXIFIER_OIDC_ISSUER_URL>/.well-known/openid-configuration` at server startup, extract `authorization_endpoint` and `token_endpoint`.

**Rationale**: Every major OIDC provider publishes a discovery document. This removes the only Google-specific code and makes provider switching a config change. The fetch happens once at startup (or lazily on first use) and is cached in memory.

**Alternative considered**: Require the operator to supply `AUTH_ENDPOINT` and `TOKEN_ENDPOINT` explicitly. Rejected — verbose, error-prone, and unnecessary given universal discovery support.

### 2. New config keys with backward-compatible aliases

**Decision**: Introduce `TMUXIFIER_OIDC_ISSUER_URL`, `TMUXIFIER_OIDC_CLIENT_ID`, `TMUXIFIER_OIDC_CLIENT_SECRET`, `TMUXIFIER_OIDC_ALLOWED_EMAILS`, `TMUXIFIER_OIDC_BUTTON_LABEL`. Map existing `TMUXIFIER_OAUTH_CLIENT_ID` / `TMUXIFIER_GOOGLE_CLIENT_ID` as aliases. Google mode continues to work by pre-populating `TMUXIFIER_OIDC_ISSUER_URL=https://accounts.google.com` when the legacy `authMode=google` is detected.

**Rationale**: Zero-migration cost for existing deployments. New deployments use clean naming.

### 3. Rename / refactor `googleAuth.js` → `oidcAuth.js`

**Decision**: Replace `createGoogleAuth` with `createOidcAuth({ issuerUrl, clientId, clientSecret, redirectUri, allowedEmails, fetchImpl })`. Internally it calls `fetchDiscovery(issuerUrl)` to resolve endpoints, then exposes the same interface (`authorizationUrl`, `exchangeCodeForEmail`, `isAllowed`). Keep `pkcePair` and `randomState` exports unchanged.

**Rationale**: The existing PKCE + token-exchange logic is correct and reusable; only the endpoint source changes. Keeping the same interface means `server.js` changes are minimal.

### 4. Silent sign-in via `prompt=none`

**Decision**: On the login page load, the web client fires a hidden iframe (or a background redirect) to `/api/auth/oauth/silent`. The server constructs an authorization URL with `prompt=none` and `response_type=code`. The iframe navigates to the provider and back to a `/api/auth/oauth/silent-callback` endpoint. On success, Tmuxifier sets the session cookie and the parent page detects the cookie change (or receives a `postMessage`) and reloads.

**Alternative considered**: Full-page redirect with `prompt=none` on every load. Rejected — causes a redirect flash on every unauthenticated page load even when no provider session exists.

**Implementation note**: Providers that don't support `prompt=none` will return `interaction_required`; the server catches this and returns a non-success status so the login page shows the button normally. The silent path is best-effort.

### 5. Auth route paths

**Decision**: New generic routes are `/api/auth/oauth/login`, `/api/auth/oauth/callback`, `/api/auth/oauth/silent`, `/api/auth/oauth/silent-callback`. The old `/api/auth/google/*` routes are kept as permanent redirects for any bookmarks, then deprecated in docs.

### 6. `authMode` normalization

**Decision**: `config.js` normalizes `authMode` to `'oauth'` (replacing `'google'`). Internal code no longer references `'google'`. The legacy check `authMode === 'google'` is replaced with `authMode === 'oauth'` everywhere.

## Risks / Trade-offs

- **Discovery fetch failure at startup** → Mitigation: fail fast with a clear error message listing the issuer URL and the missing env var, same pattern as existing auth config validation.
- **`prompt=none` not universally supported** → Mitigation: treat any error response from silent callback as "no session"; fall back gracefully to showing the login button.
- **Providers that omit `email_verified` claim** (some Authentik configs) → Mitigation: make `email_verified` check opt-out via `TMUXIFIER_OIDC_SKIP_EMAIL_VERIFIED=true`; default remains strict (verified required).
- **Renaming `googleAuth.js`** → Old import path breaks if someone has vendored it. Acceptable — this is internal server code, not a public API.
- **Silent sign-in iframe blocked by provider `frame-ancestors` CSP** → Mitigation: document the limitation; the login button remains the primary flow. Alternatively, use a full-page redirect with `prompt=none` and a short redirect timeout.

## Migration Plan

1. Deploy the new code; existing Google OAuth deployments need only add `TMUXIFIER_OIDC_ISSUER_URL=https://accounts.google.com` (or rely on the automatic alias in legacy mode).
2. New Authentik deployments follow the new docs section.
3. No data migration needed — session cookies are unaffected.
4. Old `/api/auth/google/*` routes redirect to new paths; remove the redirects in a future release after one version cycle.

## Open Questions

_All questions resolved._

- **Silent sign-in mechanism**: Use a hidden **iframe** (`<iframe src="/api/auth/oauth/silent">`). Cleaner UX — no redirect flash on the main page. If a provider's CSP blocks iframe embedding, the 5 s timeout falls back gracefully to showing the login button.
- **Wildcard email allowlist**: **Exact-match only** (current default behavior). No `*@example.com` wildcard support in this change; can be added as a follow-on if needed.
