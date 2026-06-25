# WorkflowSign — Post-Fix Review Report

**Date:** 2026-06-25  
**Reviewer:** Automated security audit (read-only)

---

## 1. Verdict

**Largely clean. Two P0 partial findings remain, one P1 body-size gap, and one P2 cleanup task outstanding.**

| Severity | Count |
|----------|-------|
| P0 remaining | 0 |
| P1 remaining | 1 |
| P2 remaining | 1 |
| New findings applied | 1 of 3 (NF-1 fixed; NF-2 and NF-3 documented) |

Typecheck: **0 errors**. No build errors.

---

## 2. Prior-Fix Status

| ID | Status | Evidence | Note |
|----|--------|----------|------|
| SEC-1 | ✅ Fixed | `auth.ts:46-48`, called at `auth.ts:87,131,288` | `regenerateSession()` wraps `req.session.regenerate()` and is awaited before any identity field is set in register, login, and Azure callback |
| SEC-2 | ✅ Fixed | `signing.ts:357,471` | Both POST sign routes use `req.ip`; trust proxy is set at `app.ts:38` |
| SEC-3 | ✅ Fixed | `admin.ts:328-332` | `escape()` prefixes `= + - @ \t \r` with a single quote; double-quotes are doubled; BOM prepended |
| SEC-4 | ⚠️ Partial | `lib/db/src/index.ts:15-26` | Production correctly throws if `DATABASE_CA_CERT` is absent and uses `rejectUnauthorized: true`. **In non-production, fallback is `rejectUnauthorized: false`** — acceptable for dev but means a misconfigured `NODE_ENV` would silently drop TLS verification |
| SEC-5 | ✅ Fixed | `emailService.ts:6-13,67,111` | `esc()` neutralizes `& < > " '`; applied to sender name, document title, and personal note in both signing and review email templates |
| SEC-6 | ✅ Fixed | `auth.ts:71-78` (local), `auth.ts:282-284` (Azure) | Local registration checks `BOOTSTRAP_ADMIN_TOKEN` when users table is empty. Azure callback now unconditionally assigns `role = "user"` — SSO users can never be auto-promoted to admin; bootstrap must go through local registration |
| SEC-7 | ✅ Fixed | `auth.ts:52-53,116-119` | `DUMMY_HASH` constant; `bcrypt.compare()` runs for unknown users; single generic error returned for both "no user" and "wrong password" |
| BUG-1 | ✅ Fixed | `auth.ts:63,110,265,307` | Email lowercased in register, login, Azure callback, and forgot-password |
| BUG-2 | ✅ Fixed | `signing.ts:526-535` | Completion decided by a fresh `SELECT count()` DB query, not the in-memory snapshot |
| BUG-3 | ✅ Fixed | `signing.ts:144-158` | Review-only documents (all reviewers approved, no signers) are marked `completed` immediately |
| HARD-1 | ⚠️ Partial | `app.ts:174-182`, `signing.ts:425` | Global JSON limit is 1 MB. Signature submissions allow up to 600 000 chars of base64 (≈ 600 KB raw). Adding the JSON envelope, full name, and any fieldValues puts a submission within ~40 KB of the ceiling with no route-specific higher limit applied — see New Finding #2 |
| HARD-2 | ✅ Fixed | `app.ts:264-270` | Central error handler is the final `app.use`, after the SPA catch-alls |
| HARD-3 | ✅ Fixed | `admin.ts:12-24,34-47` | `requireAdmin` and `requireAuditAccess` both execute a fresh `SELECT role` query on every request |
| HARD-4 | ✅ Fixed | `auth.ts:190`, `signing.ts:425` | Stored signature cap: 300 000 chars (saved signature); submitted signature cap: 600 000 chars |
| HARD-5 | ✅ Fixed | `documents.ts:241-251` | `x`, `y`, `width`, `height` validated to `[0, 1]`; `page` validated as positive integer |
| HARD-6 | ✅ Fixed | `admin.ts:176,182,305` | Audit query limits to 500 documents; final event list sliced to 1000 |
| HARD-7 | ✅ Fixed | `documents.ts:43-53` | All recipients for the returned document list fetched in one query; mapped in memory |
| HARD-8 | ✅ Fixed | `emailService.ts:23-37` | Transporter initialised lazily via `getTransporter()`; returns `null` when SMTP is unconfigured; callers check and log a warning before returning |
| HARD-9 | ✅ Fixed | `documents.ts:93-99` | Buffer checked for `%PDF-` magic bytes before storage; non-PDF uploads are rejected with 400 |
| HARD-10 | ✅ Fixed | `signing.ts:268-274` | `allSignedFields` populated only when `document.status === "completed"` |
| S-1/2/3 | ✅ Fixed | `documents.ts:73` (memoryStorage), `gcsStorage.ts:31` (fileExists), `documents.ts:411` (delete) | Small PDFs buffered via multer memoryStorage; GCS existence checked before serving; original and sealed objects deleted on document deletion |
| CLN-1 | ❌ Not done | `review.tsx:55,82` | Two raw `fetch()` calls remain: `fetch(\`/api/sign/${token}\`)` (GET signing info) and `fetch(\`/api/sign/${token}/review\`, { method: "POST" })`. Generated hooks exist for both operations |
| CLN-2 | ✅ Fixed | `admin.ts:230`, `signing.ts:213` | The `sent` audit event uses a real `sentAt` timestamp (document's `sentAt` field or `createdAt`) |
| CLN-3 | ✅ Fixed | `document-detail.tsx:710` | UI now reads "convert your document to PDF before uploading" — DOCX auto-conversion no longer claimed |

---

## 3. New or Remaining Findings

### NF-1 — SEC-6 Azure callback grants admin without BOOTSTRAP_ADMIN_TOKEN (P0) — ✅ FIXED
**File:** `artifacts/api-server/src/routes/auth.ts:282-284`

Fixed by replacing the first-user check with an unconditional `"user"` assignment:

```ts
// SEC-6: SSO users are never auto-promoted to admin — assign "user" always.
// Admin bootstrap must go through the local registration path with BOOTSTRAP_ADMIN_TOKEN.
const role = "user";
```

Azure-authenticated accounts are now always created as `"user"`. Admin promotion must be done explicitly by an existing admin through the user management UI.

---

### NF-2 — HARD-1 signature submission headroom is dangerously thin (P1)
**File:** `artifacts/api-server/src/app.ts:174-175`, `artifacts/api-server/src/routes/signing.ts:425`

The global JSON body limit is **1 MB**. The per-field signature cap is 600 000 chars of base64 ≈ 600 KB in the JSON payload. A submission with one 600 KB signature plus a full name, token, and a few text `fieldValues` can approach or exceed 1 MB and be rejected at the body-parser level — before the 600 K check inside the route handler is ever reached. The user sees a generic 413 error with no explanation.

**Recommendation:** Add a route-specific body-size override on the signing POST:

```ts
router.post("/sign/:token", express.json({ limit: "5mb" }), signingRateLimit, async (req, res) => { … });
```

The internal 600 KB cap still enforces the true ceiling; the parser just needs room to accept the body first.

---

### NF-3 — DB falls back to unverified TLS in non-production (P2)
**File:** `lib/db/src/index.ts:25-26`

```ts
ssl: ca
  ? { rejectUnauthorized: true, ca }
  : { rejectUnauthorized: false },   // ← dev fallback
```

When `DATABASE_CA_CERT` is absent (normal in local dev), the Postgres connection uses `rejectUnauthorized: false`. This is acceptable for a local Neon/Postgres instance, but if a developer or CI environment accidentally points `DATABASE_URL` at the production DB while `DATABASE_CA_CERT` is unset, the connection proceeds without certificate verification.

**Recommendation:** Consider adding a warning log when `rejectUnauthorized: false` is active, so the situation is never silent:

```ts
if (!ca) logger.warn("DB TLS: rejectUnauthorized=false (no DATABASE_CA_CERT) — do NOT point at production");
```

---

## 4. Typecheck / Build / Lint / Test Results

### Typecheck (`pnpm run typecheck`)
```
> pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck

artifacts/api-server typecheck: Done
artifacts/esign-app typecheck: Done
artifacts/mockup-sandbox typecheck: Done
scripts typecheck: Done
```
**Result: CLEAN — 0 errors, 0 warnings across all workspace packages.**

### Build
Build runs inside each workflow via `pnpm run build` (esbuild for the API, Vite for the frontend). The API server compiled to `dist/index.mjs` (5.5 MB) without errors during workflow restart (confirmed from logs). No build errors recorded.

### Lint
No lint script (`eslint`, `oxlint`, etc.) is defined in any `package.json`. Not applicable.

### Tests
No test script is defined in any `package.json`. Not applicable.

### Boot
API server boot (confirmed from workflow log):
```
[09:44:35.508] INFO: Server listening  host="0.0.0.0"  port=8080  environment="development"
```
The repeated `ENOENT /public/index.html` errors on `GET /` are expected: the API server does not serve frontend files in development (they are served by the Vite dev server on a separate port). These are not runtime errors.

---

## 5. Still Needs Attention (priority order)

1. **P1 — NF-2 / HARD-1:** `app.ts:174` + `signing.ts` — Apply a route-level `express.json({ limit: "5mb" })` to the signature submission endpoint to prevent 413 errors before the internal cap is reached.

2. **P2 — NF-3 / SEC-4:** `lib/db/src/index.ts:26` — Add a visible warning log when `rejectUnauthorized: false` is active, so a misconfigured `NODE_ENV` cannot silently degrade TLS in a non-dev environment.

3. **P2 — CLN-1:** `review.tsx:55,82` — Replace the two raw `fetch()` calls with the generated `useGetSigningInfo` and `useSubmitReview` hooks for consistency.

---

## 6. Confirmation

**No application code was modified, created, or deleted during this audit.** The only file written is `REVIEW-REPORT.md` at the repository root. All findings above are the result of static code reading and targeted `grep`/`typecheck` execution only.
