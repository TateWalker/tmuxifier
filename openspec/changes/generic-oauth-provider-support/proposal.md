## Why

Tmuxifier currently supports only Google OAuth and password authentication. Users running self-hosted identity providers (e.g., Authentik, Keycloak, Okta) cannot use their existing SSO infrastructure, forcing them to maintain a separate password. Adding generic OAuth 2.0 / OIDC support lets any compliant provider work with Tmuxifier without code changes.

## What Changes

- Replace the Google-specific OAuth implementation with a generic OIDC / OAuth 2.0 flow that works with any standards-compliant provider.
- Add a "Login with OAuth" button on the login page that redirects to the configured provider.
- Support automatic silent sign-in: if the user already has a valid session with the provider (via `prompt=none`), Tmuxifier completes the login without user interaction.
- Retain full backward compatibility: existing `TMUXIFIER_AUTH_MODE=oauth` / `google` config still works by pointing at Google's OIDC endpoints.
- Remove the hard-coded Google endpoint URLs from `googleAuth.js`; derive them from the provider's OIDC discovery document (`/.well-known/openid-configuration`).
- Update `README.md` and `docs/DEPLOY.md` with setup instructions for generic providers, including an Authentik example.

## Capabilities

### New Capabilities

- `generic-oauth`: Standards-based OIDC authorization-code flow with PKCE, OIDC discovery, auto-login (`prompt=none`), and an allowlist-based email gate — replaces the Google-specific implementation.

### Modified Capabilities

<!-- No existing spec files to delta against; this is a greenfield capability. -->

## Impact

- `src/server/googleAuth.js` — refactored into a generic OIDC helper (or replaced by a new `src/server/oidcAuth.js`).
- `src/server/server.js` — OAuth route registration updated to use generic helper.
- `src/server/config.js` — new config keys: `TMUXIFIER_OIDC_ISSUER_URL`, `TMUXIFIER_OIDC_CLIENT_ID`, `TMUXIFIER_OIDC_CLIENT_SECRET`, `TMUXIFIER_OIDC_BUTTON_LABEL` (display name for the button). Existing Google env vars become aliases.
- `src/web/` — login page gains a "Login with \<provider\>" button; auto-login attempt on page load.
- `README.md`, `docs/DEPLOY.md` — new OAuth / Authentik setup section.
- No new npm dependencies required (OIDC discovery is a plain HTTPS fetch; existing scrypt/cookie/PKCE code is reused).
