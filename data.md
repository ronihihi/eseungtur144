# WorkflowSign — Infrastructure Reference

_Generated June 2026_

---

## Overview

| Item | Value |
|---|---|
| Application | WorkflowSign (DocuSign-style e-signature platform) |
| Current host | Replit (migrating to DigitalOcean App Platform) |
| Architecture | Monorepo — single web service (API + frontend served together) |
| Region (DO target) | FRA1 — Frankfurt, Germany |

---

## Runtime

| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js | 24.x |
| Package manager | pnpm | 10.26.1 |
| Language | TypeScript | 5.9.x |
| Frontend framework | React + Vite | 19 / 7 |
| Backend framework | Express | 5.x |
| ORM | Drizzle ORM | (catalog pin) |

---

## Services Map

```
Internet
    │
    ▼
DigitalOcean App Platform
    │
    ├── Web Service: api  (Node.js, port 8080)
    │       ├── POST/GET /api/*        → Express routes
    │       ├── GET /sign/*            → sign.html  (SPA)
    │       └── GET /*                 → index.html (SPA)
    │
    ├── Managed Database: db  (PostgreSQL 16, FRA1)
    │
    └── External: Google Cloud Storage  (PDF file storage)
```

---

## Compute

| Resource | Value |
|---|---|
| Platform | DigitalOcean App Platform |
| Service type | Web Service |
| Instance size | basic-xxs (scale up as needed) |
| Instance count | 1 |
| HTTP port | 8080 |
| Health check path | `/health` |
| Deployment method | Dockerfile (Node 24 + pnpm 10.26.1) |
| Auto-deploy | On push to `main` branch |

---

## Database

| Property | Value |
|---|---|
| Engine | PostgreSQL 16 |
| Host | DigitalOcean Managed PostgreSQL |
| Region | FRA1 (Frankfurt) |
| SSL | Required — CA cert injected as `DATABASE_CA_CERT` |
| Connection | `DATABASE_URL` (DO binding `${db.DATABASE_URL}`) |
| Session table | `user_sessions` (auto-created by connect-pg-simple) |
| Migration tool | Drizzle Kit (`drizzle-kit push` / `drizzle-kit migrate`) |

### Tables

| Table | Purpose |
|---|---|
| `users` | Registered accounts (email, password hash) |
| `documents` | Uploaded PDF metadata + GCS file path |
| `recipients` | Per-document signers/reviewers with unique tokens |
| `signature_fields` | Field placements (fractional x/y/w/h per page) |
| `document_events` | Audit trail (sign, review, send, remind events) |
| `user_sessions` | Express session store |

---

## File Storage

| Property | Value |
|---|---|
| Provider | Google Cloud Storage (GCS) |
| Auth method | Service account JSON key (`GCP_SA_KEY_B64` — base64) |
| Bucket env var | `DEFAULT_OBJECT_STORAGE_BUCKET_ID` |
| URI scheme | `gcs://<bucket-id>/<object-name>` stored in `documents.filepath` |
| Files stored | Original PDFs, signed PDFs |
| Total existing files | 83 PDFs (exported to `bucket-export/` for migration) |

---

## Networking

| Item | Value |
|---|---|
| Current Replit outbound IP | `34.93.103.139` _(ephemeral — do not rely on this)_ |
| Production domain | Assigned by DO at deploy time (`*.ondigitalocean.app`) |
| Custom domain | Configure in DO App Platform after first deploy |
| CORS allowed origin | Set via `APP_ORIGIN` env var |
| Proxy trust | `app.set("trust proxy", 1)` — trusts DO's load balancer |
| Cookies | `Secure: true`, `HttpOnly: true`, `SameSite: lax` in production |

---

## Authentication

| Method | Details |
|---|---|
| Primary | Email + password (bcryptjs hash, express-session cookie) |
| Session store | PostgreSQL via connect-pg-simple |
| Session cookie | `esign.sid`, 24-hour TTL |
| Optional SSO | Microsoft Azure AD (OAuth2 via `AZURE_*` env vars) |
| Recipient access | UUID token in URL — no account required to sign |

---

## Email

| Property | Value |
|---|---|
| Library | nodemailer |
| Transport | SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) |
| Behavior if unconfigured | Silently skipped — signing links still copyable |
| Sent events | Recipient invitation, reminder |

---

## Build Pipeline

```
pnpm install --frozen-lockfile
    │
    ├── pnpm --filter @workspace/api-server run build
    │       └── esbuild → artifacts/api-server/dist/index.mjs
    │
    └── pnpm --filter @workspace/esign-app run build
            └── vite build → artifacts/esign-app/dist/public/
                    ├── index.html
                    ├── sign.html  (noindex, for /sign/* routes)
                    └── assets/
```

Docker image final layout:
```
/app/
  dist/index.mjs        ← API bundle
  node_modules/         ← production deps only
  public/               ← React build (served as static files)
    index.html
    sign.html
    assets/
```

---

## Key Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_CA_CERT` | Yes (DO) | TLS CA cert for managed Postgres |
| `SESSION_SECRET` | Yes | Cookie signing key |
| `APP_URL` | Yes | Public base URL (used in email links) |
| `APP_ORIGIN` | Yes | Allowed CORS origin(s) |
| `GCP_SA_KEY_B64` | Yes | GCS service account (base64 JSON) |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Yes | GCS bucket name |
| `SMTP_*` | Optional | Outbound email |
| `AZURE_*` | Optional | Microsoft SSO |

Full reference: see `envermentsss.md`

---

## Migration Status

| Phase | Description | Status |
|---|---|---|
| Phase 0 | Decisions locked (GCS keep, single service, Dockerfile, FRA1) | ✅ Done |
| Phase 1 | Code fixes (PG SSL, GCS auth, Dockerfile, static serving, cleanup) | ✅ Done |
| Phase 2 | Push to GitHub & open PR | ⬜ Pending |
| Phase 3 | Provision DO Managed PostgreSQL (FRA1) | ⬜ Pending |
| Phase 4 | Create DO App + attach DB + set env vars | ⬜ Pending |
| Phase 5 | Run Drizzle schema push against new DB | ⬜ Pending |
| Phase 6 | Migrate existing data (83 PDFs + DB rows) | ⬜ Pending |

Full runbook: see attached `Pasted--WorkflowSign-DigitalOcean...` asset.

---

## Repository Structure

```
workflowsign/
├── artifacts/
│   ├── api-server/          ← Express API (Node.js)
│   │   └── src/
│   │       ├── app.ts       ← middleware, static serving, CORS, sessions
│   │       ├── index.ts     ← HTTP server, port binding, graceful shutdown
│   │       ├── routes/      ← auth, documents, recipients, signing, admin
│   │       └── lib/         ← gcsStorage, appUrl, logger
│   └── esign-app/           ← React + Vite frontend
├── lib/
│   ├── db/                  ← Drizzle ORM schema + pool (lib/db/src/index.ts)
│   ├── api-spec/            ← OpenAPI spec (source of truth)
│   ├── api-client-react/    ← Generated TanStack Query hooks
│   └── api-zod/             ← Generated Zod schemas
├── Dockerfile               ← Three-stage build (base → build → production)
├── .dockerignore
├── .do/app.yaml             ← DO App Platform declarative spec
├── MIGRATION.md             ← Migration audit report
├── envermentsss.md          ← Environment variables reference
└── data.md                  ← This file
```
