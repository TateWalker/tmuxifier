## ADDED Requirements

### Requirement: OIDC provider configuration
The system SHALL accept a generic OIDC provider configuration via environment variables: `TMUXIFIER_OIDC_ISSUER_URL`, `TMUXIFIER_OIDC_CLIENT_ID`, `TMUXIFIER_OIDC_CLIENT_SECRET`. The existing `TMUXIFIER_OAUTH_CLIENT_ID` and `TMUXIFIER_GOOGLE_CLIENT_ID` variables SHALL be accepted as aliases for backward compatibility. When `authMode` is set to the legacy value `google`, the system SHALL automatically set the issuer URL to `https://accounts.google.com` if no issuer URL is provided.

#### Scenario: Valid generic provider config
- **WHEN** `TMUXIFIER_AUTH_MODE=oauth`, `TMUXIFIER_OIDC_ISSUER_URL`, `TMUXIFIER_OIDC_CLIENT_ID`, and `TMUXIFIER_OIDC_CLIENT_SECRET` are all set
- **THEN** the server SHALL start successfully in OAuth mode

#### Scenario: Missing issuer URL in oauth mode
- **WHEN** `TMUXIFIER_AUTH_MODE=oauth` is set but `TMUXIFIER_OIDC_ISSUER_URL` is absent
- **THEN** the server SHALL fail fast with an error message that names the missing variable

#### Scenario: Legacy google alias
- **WHEN** `TMUXIFIER_AUTH_MODE=google` is set and no `TMUXIFIER_OIDC_ISSUER_URL` is provided
- **THEN** the system SHALL behave as if `TMUXIFIER_OIDC_ISSUER_URL=https://accounts.google.com` was set

#### Scenario: Legacy client ID alias
- **WHEN** `TMUXIFIER_OAUTH_CLIENT_ID` is set but `TMUXIFIER_OIDC_CLIENT_ID` is not
- **THEN** the system SHALL use `TMUXIFIER_OAUTH_CLIENT_ID` as the client ID

### Requirement: OIDC endpoint discovery
The system SHALL fetch the provider's OIDC discovery document from `<issuerUrl>/.well-known/openid-configuration` and extract `authorization_endpoint` and `token_endpoint`. Discovery SHALL occur before the server begins handling requests (fail-fast) or on first use. The resolved endpoints SHALL be cached for the lifetime of the process.

#### Scenario: Successful discovery
- **WHEN** the issuer URL resolves to a valid OIDC discovery document
- **THEN** the system SHALL extract `authorization_endpoint` and `token_endpoint` from the document and use them for all OAuth flows

#### Scenario: Discovery fetch failure
- **WHEN** the discovery document cannot be fetched (network error, 404, invalid JSON)
- **THEN** the server SHALL fail with a clear error message including the attempted discovery URL

#### Scenario: Discovery document missing required fields
- **WHEN** the discovery document is fetched successfully but lacks `authorization_endpoint` or `token_endpoint`
- **THEN** the server SHALL fail with an error naming the missing field(s)

### Requirement: Authorization-code flow with PKCE
The system SHALL implement the OAuth 2.0 authorization-code flow with PKCE (S256) using the discovered endpoints. The flow SHALL request the `openid email` scope. A short-lived signed state cookie SHALL be used to bind the authorization request to the callback.

#### Scenario: Login redirect
- **WHEN** an unauthenticated user hits `GET /api/auth/oauth/login`
- **THEN** the server SHALL redirect to the provider's `authorization_endpoint` with `response_type=code`, `scope=openid email`, `state`, `code_challenge`, and `code_challenge_method=S256`

#### Scenario: Callback success
- **WHEN** the provider redirects to `/api/auth/oauth/callback` with a valid `code` and matching `state`
- **THEN** the server SHALL exchange the code for tokens at `token_endpoint`, extract the email from the `id_token`, verify it is in the allowed-email list, set a signed session cookie, and redirect to `/`

#### Scenario: Callback state mismatch
- **WHEN** the `state` parameter in the callback does not match the state cookie
- **THEN** the server SHALL reject the request and redirect to `/?error=oauth`

#### Scenario: Email not in allowlist
- **WHEN** the provider returns a valid token but the email is not in `TMUXIFIER_OIDC_ALLOWED_EMAILS`
- **THEN** the server SHALL redirect to `/?error=forbidden` without setting a session cookie

### Requirement: Email verification enforcement
The system SHALL require `email_verified: true` in the id_token payload by default. Operators MAY set `TMUXIFIER_OIDC_SKIP_EMAIL_VERIFIED=true` to disable this check for providers that omit the claim.

#### Scenario: Unverified email rejected by default
- **WHEN** the id_token contains `email_verified: false` (or the field is absent)
- **THEN** the server SHALL redirect to `/?error=forbidden`

#### Scenario: Skip verification flag
- **WHEN** `TMUXIFIER_OIDC_SKIP_EMAIL_VERIFIED=true` is set and the id_token lacks `email_verified`
- **THEN** the server SHALL accept the email and proceed with the allowlist check

### Requirement: OAuth login button on login page
The login page SHALL display a "Login with \<provider\>" button when `authMode` is `oauth`. The button label SHALL use the value of `TMUXIFIER_OIDC_BUTTON_LABEL` if set, falling back to `"OAuth"`.

#### Scenario: Button displayed in oauth mode
- **WHEN** the login page is loaded and `authMode` is `oauth`
- **THEN** the page SHALL display a button that navigates to `/api/auth/oauth/login` and is labeled with the configured provider name

#### Scenario: Button absent in password mode
- **WHEN** the login page is loaded and `authMode` is `password`
- **THEN** no OAuth button SHALL be displayed

#### Scenario: Custom button label
- **WHEN** `TMUXIFIER_OIDC_BUTTON_LABEL=Authentik` is configured
- **THEN** the button label SHALL read "Login with Authentik"

### Requirement: Silent automatic sign-in
The system SHALL attempt a silent sign-in (`prompt=none`) when the login page is loaded in OAuth mode. If the user already has an active provider session, they SHALL be signed in to Tmuxifier automatically without clicking the login button.

#### Scenario: Silent sign-in succeeds
- **WHEN** the login page loads in oauth mode and the user has an active provider session
- **THEN** the system SHALL complete authentication silently and redirect the user to the dashboard without requiring any interaction

#### Scenario: Silent sign-in fails gracefully
- **WHEN** the provider returns `interaction_required` or `login_required` during the silent attempt
- **THEN** the login page SHALL display normally with the "Login with \<provider\>" button, without any error or redirect flash

#### Scenario: Silent sign-in not supported by provider
- **WHEN** the provider does not support `prompt=none` and returns an error
- **THEN** the login page SHALL display normally with the login button; no uncaught error SHALL propagate

### Requirement: Legacy Google route compatibility
The system SHALL preserve `/api/auth/google/login` and `/api/auth/google/callback` as redirects to the new `/api/auth/oauth/*` paths for one version cycle.

#### Scenario: Legacy login redirect
- **WHEN** a request hits `GET /api/auth/google/login`
- **THEN** the server SHALL respond with a 302 redirect to `/api/auth/oauth/login`

#### Scenario: Legacy callback redirect
- **WHEN** a request hits `GET /api/auth/google/callback`
- **THEN** the server SHALL respond with a 302 redirect to `/api/auth/oauth/callback` preserving the query string

### Requirement: Auth info endpoint reports generic mode
The `/api/auth/info` endpoint SHALL return `{ "mode": "oauth" }` for all OAuth provider configurations, regardless of whether the provider is Google or another service.

#### Scenario: Auth info in oauth mode
- **WHEN** `GET /api/auth/info` is called and `authMode` is `oauth`
- **THEN** the response SHALL be `{ "mode": "oauth" }`

#### Scenario: Auth info in password mode
- **WHEN** `GET /api/auth/info` is called and `authMode` is `password`
- **THEN** the response SHALL be `{ "mode": "password" }`
