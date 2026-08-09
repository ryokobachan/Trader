# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** flow in the repository Security tab when available. If it is unavailable, contact the maintainer through the GitHub profile without including secrets in public comments.

Include the affected route or component, impact, reproduction steps, and a minimal proof of concept. Never include real API keys, session cookies, personal data, or third-party licensed datasets.

## Supported version

Unicorn is currently a pre-1.0 prototype. Security fixes target the latest `main` branch.

## Deployment boundary

The default repository is designed for local development. Hosted persistent APIs require a Sites-authenticated user identity and fail closed for anonymous non-loopback requests. Optional Yahoo, TradingView websocket, Benzinga, and FMP adapters are not an entitlement to use or redistribute provider data.
