---
name: Bootstrap admin token for production
description: How the first-user admin land-grab is prevented in production deployments.
---

In `artifacts/api-server/src/routes/auth.ts`, registration reads `process.env.BOOTSTRAP_ADMIN_TOKEN`. On a fresh DB:
- If the env var is **not set** (dev): first registrant becomes admin automatically (preserves dev convenience).
- If the env var **is set** (production): the registration body must include `{ bootstrapToken: "<value>" }` matching the env var to receive the admin role; otherwise the account is created as a regular user.

**Why:** An open first-user-becomes-admin pattern lets whoever registers first on a freshly deployed DigitalOcean instance silently claim admin rights.

**How to apply:** Set `BOOTSTRAP_ADMIN_TOKEN` to a long random secret in the production environment before deploying. Use it once to bootstrap the first admin, then it can be removed or rotated. Azure OAuth callback applies the same check for the first Azure account.
