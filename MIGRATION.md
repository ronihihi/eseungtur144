# WorkflowSign — DigitalOcean App Platform Migration Audit

> **Scope:** Inspection only — no code was changed. All quoted lines are verbatim from the files noted.
> **Date:** June 2026

---

## 1. Runtime

| Item | Value |
|---|---|
| Language | Node.js |
| Required version | **24.x** |
| Package manager | **pnpm 10.26.1** |

**Evidence — `package.json` (root):**
```json
"engines": {
  "node": "24.x",
  "pnpm": "10.26.1"
}
```

**Evidence — `.replit`:**
```toml
modules = ["nodejs-24", "postgresql-16"]
```

**DO action:** Pin the App Platform component runtime to **Node.js 24**. At time of writing DO App Platform supports Node 22 LTS and 20 LTS as managed runtimes. Node 24 requires a **Dockerfile** (see §10).

---

## 2. Start Command

The API is compiled to an ESM bundle before starting.

**Production run command (from `artifacts/api-server/.replit-artifact/artifact.toml`):**
```toml
[services.production.run]
args = ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
```

**Confirmed in `artifacts/api-server/package.json`:**
```json
"start": "node --enable-source-maps ./dist/index.mjs"
```

The React frontend is served as **static files** from `artifacts/esign-app/dist/public` — it is not a Node process. It needs a static-file host (DO Spaces CDN, or the built-in `serve: "static"` directive in the toml).

---

## 3. Build Commands

Two separate build steps must run before start:

**Step 1 — Install dependencies:**
```bash
pnpm install --frozen-lockfile
```

**Step 2 — Build API server** (esbuild bundle, output → `artifacts/api-server/dist/`):
```bash
pnpm --filter @workspace/api-server run build
```
Internally this runs `node ./build.mjs`, which calls esbuild with `format: "esm"`, bundles all source, and externalises native/heavy packages (`@google-cloud/*`, `nodemailer`, `pg-native`, etc.).

**Step 3 — Build frontend** (Vite, output → `artifacts/esign-app/dist/public/`):
```bash
pnpm --filter @workspace/esign-app run build
```
The Vite build also generates `sign.html` from `index.html` via a `closeBundle` plugin (needed for the `/sign/*` SPA route).

**Combined build command for DO:**
```bash
pnpm install --frozen-lockfile && \
pnpm --filter @workspace/api-server run build && \
pnpm --filter @workspace/esign-app run build
```

---

## 4. Port Binding

✅ **Correct.** The server explicitly binds to `0.0.0.0` and reads `PORT` from the environment.

**`artifacts/api-server/src/index.ts`:**
```typescript
const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const host = "0.0.0.0";

const server = app.listen(port, host, () => {
```

The production `artifact.toml` sets `PORT = "8080"` — set the same on DO. No hardcoded port exists in the source.

---

## 5. Environment Variables

### Required — server will refuse to start without these

| Name | Where read | Evidence |
|---|---|---|
| `PORT` | `artifacts/api-server/src/index.ts` | `process.env.PORT` — throws if missing |
| `DATABASE_URL` | `lib/db/src/index.ts`, `artifacts/api-server/src/app.ts` | `process.exit(1)` if missing |
| `SESSION_SECRET` | `artifacts/api-server/src/app.ts` | `process.exit(1)` if missing |
| `NODE_ENV` | `artifacts/api-server/src/app.ts` | Must be `"production"` on DO |
| `APP_ORIGIN` | `artifacts/api-server/src/app.ts` | `process.exit(1)` in production if missing — comma-separated allowed CORS origins |

### Required for file storage (see §8 for blocker detail)

| Name | Where read |
|---|---|
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | `artifacts/api-server/src/lib/gcsStorage.ts` — throws if missing |

### Optional features

| Name | Where read | If absent |
|---|---|---|
| `APP_URL` | `artifacts/api-server/src/lib/appUrl.ts` | Falls back to `req.get("host")` — set this for correct signing email links |
| `SMTP_HOST` | `artifacts/api-server/src/routes/recipients.ts` | Email silently skipped |
| `SMTP_PORT` | Same | Same |
| `SMTP_USER` | Same | Same |
| `SMTP_PASS` | Same | Same |
| `AZURE_TENANT_ID` | `artifacts/api-server/src/routes/auth.ts` | Microsoft SSO button hidden |
| `AZURE_CLIENT_ID` | Same | Same |
| `AZURE_CLIENT_SECRET` | Same | Same |
| `AZURE_REDIRECT_URI` | Same | Defaults to `{APP_URL}/api/auth/azure/callback` |
| `LOG_LEVEL` | `artifacts/api-server/src/lib/logger.ts` | Defaults to `"info"` |

### Replit-specific — do NOT recreate on DO

| Name | Why it exists | Action |
|---|---|---|
| `REPLIT_DOMAINS` | `appUrl.ts` fallback for base URL | Ignored once `APP_URL` is set |
| `REPL_ID` | Vite config guards dev-only Replit plugins | Harmless — those plugins are excluded when `NODE_ENV=production` |

---

## 6. Database

**Engine:** PostgreSQL 16  
**ORM:** Drizzle ORM (`drizzle-orm/node-postgres`)  
**Session store:** `connect-pg-simple` (sessions stored in `user_sessions` table)

**`lib/db/src/index.ts`:**
```typescript
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

**`artifacts/api-server/src/app.ts`:**
```typescript
const sessionStore = new PgStore({
  conString: databaseUrl,
  tableName: "user_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 60 * 60,
});
```

### ⚠️ SSL NOT enforced — BLOCKER

`new Pool({ connectionString: process.env.DATABASE_URL })` passes no `ssl` option. DigitalOcean Managed PostgreSQL **requires SSL** and rejects plain connections.

**Fix:** append `?sslmode=require` to the `DATABASE_URL` connection string, or add `ssl: { rejectUnauthorized: false }` to the Pool options and supply the DO CA certificate.

---

## 7. Filesystem Writes

### 7a. Legacy `uploads/` directory

**`artifacts/api-server/src/routes/documents.ts` lines 15–17:**
```typescript
// Keep a local uploads dir for backward-compat with old local-path documents
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
```

**Risk level:** Low. This directory is created at startup but **no new files are written to it**. It exists only to serve documents that were stored on local disk before the GCS migration. New uploads go directly to GCS. On DO's ephemeral filesystem it will be created fresh each deploy; old local-path rows in the database will return 404 (those records predate the current storage backend).

**Recommendation:** Remove this block after verifying no `documents.filepath` rows contain a local path (i.e., all rows start with `gcs://`).

### 7b. All new file storage — GCS

All current PDF uploads and sealed PDFs are streamed to Google Cloud Storage via `uploadToGcs()` in `gcsStorage.ts`. No other active disk writes exist in the server code. Session data is in PostgreSQL via `connect-pg-simple`. Log output goes to stdout (Pino).

**Summary: no active data is written to local disk.** The only risk is the legacy `uploads/` directory noted above.

---

## 8. Replit Coupling

### 🔴 BLOCKER — GCS authentication via Replit sidecar

**`artifacts/api-server/src/lib/gcsStorage.ts` lines 4–22:**
```typescript
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const gcsClient = new GcsStorage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  } as any,
  projectId: "",
});
```

The GCS client authenticates through a Replit-managed credential sidecar running at `127.0.0.1:1106`. **This process does not exist on DigitalOcean.** Every file upload, download, and stream will fail with a connection refused error.

**Fix options:**
- **Option A (keep GCS):** Create a GCP service account, download its JSON key, store it as a secret, and initialise `Storage` with `keyFilename` or `credentials`. Change `DEFAULT_OBJECT_STORAGE_BUCKET_ID` to the real GCS bucket name.
- **Option B (switch to DO Spaces):** Replace `gcsStorage.ts` with an AWS S3-compatible client pointed at DigitalOcean Spaces. The `gcs://` URI scheme stored in `documents.filepath` must be updated or a translation layer added.

All 83 existing PDFs have already been exported to `bucket-export/` — they must be transferred to the new bucket before cutover.

### ⚠️ `appUrl.ts` — Replit domains fallback

**`artifacts/api-server/src/lib/appUrl.ts` lines 5–8:**
```typescript
const replitDomains = process.env.REPLIT_DOMAINS;
if (replitDomains) {
  const primary = replitDomains.split(",")[0].trim();
  return `https://${primary}`;
}
```

This is a soft fallback. `REPLIT_DOMAINS` will be undefined on DO, so the function falls through to `req.get("host")`. Setting `APP_URL` bypasses this entirely and is the correct fix.

### ✅ Replit Vite plugins — dev-only, no production impact

**`artifacts/esign-app/vite.config.ts`:**
```typescript
...(process.env.NODE_ENV !== "production" &&
process.env.REPL_ID !== undefined
  ? [
      await import("@replit/vite-plugin-cartographer").then(...),
      await import("@replit/vite-plugin-dev-banner").then(...),
    ]
  : []),
```

The three `@replit/*` Vite plugins (`vite-plugin-cartographer`, `vite-plugin-dev-banner`, `vite-plugin-runtime-error-modal`) are explicitly excluded from production builds. They will not be in the built bundle and pose no risk.

### ✅ No Replit Auth, no Replit DB key-value store

The app uses session-based auth (bcryptjs + express-session), not Replit Auth. There is no usage of `@replit/database` or the Replit key-value store.

### ℹ️ `replit.nix` — LibreOffice

**`replit.nix`:**
```nix
{pkgs}: {
  deps = [
    pkgs.libreoffice
  ];
}
```

LibreOffice was previously used for DOCX-to-PDF conversion. That feature has been removed — PDF-only uploads are now enforced. LibreOffice is not referenced anywhere in the current server source code and does not need to be installed on DO.

---

## 9. Background Work

**No cron jobs, no WebSocket server, no worker threads, no message queues.**

The only time-based code is a graceful-shutdown timeout guard in `index.ts`:

```typescript
setTimeout(() => {
  logger.error("Graceful shutdown timed out");
  process.exit(1);
}, 10_000).unref();
```

This fires only during SIGTERM handling — it is not a background job.

`connect-pg-simple` runs an in-process session pruning interval (`pruneSessionInterval: 60 * 60`), but this is a simple `setInterval` inside the existing Node process, not a separate worker.

---

## 10. Dockerfile

**No Dockerfile exists.**

DigitalOcean App Platform supports two deployment modes:

| Mode | Suitability for this project |
|---|---|
| **Managed buildpack** (auto-detect) | ❌ Poor — pnpm workspaces with multiple build targets are not well-supported by DO's auto-detection. The build requires pnpm 10, Node 24, and two separate build commands. |
| **Dockerfile** | ✅ Recommended — gives full control over the Node version, pnpm version, build steps, and final image. |

**Recommended minimal Dockerfile:**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

# ── Build stage ──────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib/ ./lib/
COPY artifacts/ ./artifacts/
COPY scripts/ ./scripts/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build
RUN pnpm --filter @workspace/esign-app run build

# ── Production image ─────────────────────────────────────────────────────────
FROM node:24-slim AS production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app

# Copy only what the runtime needs
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/api-server/dist/ ./artifacts/api-server/dist/
COPY artifacts/esign-app/public/ ./artifacts/api-server/public/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
```

The built frontend (`artifacts/esign-app/dist/public/`) should be deployed separately as a **Static Site** component on DO App Platform, configured with the SPA rewrites:
- `/sign/*` → `sign.html`
- `/*` → `index.html`

---

## Blockers Checklist

Everything in this list **will break or cause data loss** on a fresh DO deployment and must be resolved before going live.

- [ ] **🔴 BLOCKER — GCS sidecar authentication**  
  `gcsStorage.ts` connects to `http://127.0.0.1:1106` (Replit-only). Every file read/write will fail. Replace with GCS service account credentials or migrate to DigitalOcean Spaces.

- [ ] **🔴 BLOCKER — PostgreSQL SSL not enforced**  
  `new Pool({ connectionString: process.env.DATABASE_URL })` has no `ssl` option. DO Managed Postgres rejects plain connections. Add `?sslmode=require` to `DATABASE_URL` or set `ssl: { rejectUnauthorized: false }` in the Pool config.

- [ ] **🔴 BLOCKER — `APP_ORIGIN` not set**  
  `app.ts` calls `process.exit(1)` in production if `APP_ORIGIN` is missing. Must be set to the frontend's public URL (e.g. `https://workflowsign.ondigitalocean.app`).

- [ ] **🔴 BLOCKER — Node 24 requires a Dockerfile**  
  DO App Platform managed buildpacks max out at Node 22. A Dockerfile is needed to pin Node 24 and pnpm 10.26.1.

- [ ] **⚠️ Object storage migration — existing files**  
  83 PDFs live in the Replit-managed GCS bucket. They must be copied to the new bucket before cutover. Files are already exported to `bucket-export/` in this repo.

- [ ] **⚠️ `APP_URL` must be set**  
  Used to build recipient signing links in outbound emails. Without it links fall back to `req.get("host")`, which may be an internal DO hostname.

- [ ] **⚠️ Legacy `uploads/` directory**  
  Created at startup (`documents.ts` line 17). Harmless on DO but any `documents.filepath` rows that contain a local filesystem path (not `gcs://...`) will return 404. Verify all rows use GCS paths and remove the `mkdirSync` call.

- [ ] **ℹ️ Remove `REPLIT_DOMAINS` fallback**  
  `appUrl.ts` will silently fall through to `req.get("host")` on DO, which is acceptable. But once `APP_URL` is set the `REPLIT_DOMAINS` branch is dead code and can be removed for clarity.

- [ ] **ℹ️ `@replit/*` dev plugins**  
  Present in `package.json` but excluded from production builds. Safe to leave; can be removed from `devDependencies` after migration to keep the tree clean.
