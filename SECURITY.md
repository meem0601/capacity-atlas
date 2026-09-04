# Security Policy

## Reporting a vulnerability

Please do not disclose credential exposure, authentication bypasses, arbitrary file access, or loopback API vulnerabilities in a public issue. Contact the repository maintainer privately through GitHub Security Advisories.

Do not include real OAuth tokens, cookies, API keys, account exports, or credential files in reports. Use redacted logs and minimal synthetic reproductions.

## Security model

- The Connector binds to `127.0.0.1` only.
- Browser origins are allowlisted exactly; unrelated localhost ports are rejected.
- Every API except health requires an ephemeral per-launch capability token.
- OAuth children have a 15-minute TTL, explicit cancellation, one active session per provider, and Connector-shutdown cleanup.
- Runtime metadata containing the ephemeral token is stored locally with mode `0600` on POSIX systems and under the user-profile ACL on Windows, then removed on shutdown.
- Provider credentials remain in provider-managed local credential storage.
- The hosted UI does not receive or persist provider credentials or real quota data.
- Capacity Atlas never asks users to paste tokens into the browser UI.

## Adoption analytics

The hosted production UI uses Vercel Web Analytics to count page views and a fixed allowlist of setup milestones: OS-specific download clicks, Connector readiness, dashboard readiness, and OAuth start/outcome by provider. The packaged local UI sends only those fixed milestones to the first-party `/api/adoption-event` endpoint; the API validates the allowlist again and forwards anonymous event counts to Vercel Web Analytics. Events never include account names, email addresses, account identifiers, credentials, quota values, reset times, or error text. The local UI respects browser Do Not Track, and the Connector binary never sends telemetry.

## Supported versions

Security fixes are applied to the latest release line.
