# WorkflowSign — Security & Bug Remediation

**For:** SOS Children's Villages Palestine — WorkflowSign e-signature platform
**Context:** Pre-cutover fixes for migration from Replit → DigitalOcean App Platform
**Generated:** 2026-06-25
**Source review:** Full source export (`codeis.md`), reviewed line-by-line.

---

## How to use this document

Each item has a stable ID, a severity, the exact file/location, the problem in one or two sentences, and a concrete fix. Where a fix is a clear code change it is given as a diff-style snippet; where the relevant file was summarized rather than shown in the export, the fix is described and flagged **VERIFY**.

Severity:

| Tag | Meaning |
|-----|---------|
| `P0` | Security — fix **before** the DigitalOcean cutover / before handling real documents |
| `P1` | Functional bug or hardening that materially affects correctness, integrity, or resilience |
| `P2` | Cleanup / consistency — schedule, not blocking |

Authz model is **not** in this list because it is sound as written: every `/documents/:id*` route scopes by `uploadedBy = session.userId`, public routes are token-gated with expiry, and the Azure `azureId`-only lookup correctly blocks pre-account-takeover. Don't regress those during these fixes.

A storage-layer note: items **S-1**, **S-2**, and **S-3** touch `gcsStorage.ts`. If the DigitalOcean Spaces (S3-SDK) rewrite is already in progress, apply those fixes in the new storage module rather than the GCS one.

---

## P0 — Security (fix before cutover)

### SEC-1 · Session fixation
**File:** `artifacts/api-server/src/routes/auth.ts` — `/auth/login`, `/auth/register`, `/auth/azure/callback`
**Problem:** All three set `req.session.userId` (and friends) on the *existing* session without rotating the session ID. An attacker who plants a known `esign.sid` cookie keeps a fully authenticated session once the victim logs in. `httpOnly` / `secure` / `sameSite:lax` reduce the planting surface but do not close it.
**Fix:** Regenerate the session immediately before writing identity fields. Add a helper and call it in all three handlers.

```ts
// add near the top of auth.ts
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  );
}

// in each handler, BEFORE assigning req.session.userId = ...
await regenerateSession(req);
req.session.userId = user.id;
// ...set the remaining session fields as before
```

For the Azure callback, regenerate after you have resolved `user` and before the redirect. Logout already calls `req.session.destroy()`, which is correct — leave it.

---

### SEC-2 · Spoofable IP recorded against signatures
**File:** `artifacts/api-server/src/routes/signing.ts` — `POST /sign/:token` and `POST /sign/:token/review`
**Problem:** IP is read straight from the request header:

```ts
const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
```

With `app.set("trust proxy", 1)`, the raw `x-forwarded-for` value is attacker-prefixable and is a comma-separated chain, not a clean IP. A signer can forge the IP that ends up on the sealed-PDF certificate and in the audit log — an evidence-integrity problem for a legally-binding e-signature tool.
**Fix:** Use Express's computed `req.ip`, which (with `trust proxy 1`) is the address the DigitalOcean load balancer observed.

```ts
const ip = req.ip ?? req.socket.remoteAddress ?? "";
```

Apply in both routes. No other change needed — `trust proxy 1` is already set in `app.ts`.

---

### SEC-3 · CSV formula injection in audit export
**File:** `artifacts/api-server/src/routes/admin.ts` — `GET /admin/audit/export`
**Problem:** The CSV `escape()` only doubles quotes; it does not neutralize spreadsheet formula prefixes. Attacker-controlled fields reach the export: `actorName` (= a signer's `fullName`, submitted on the public signing endpoint), document title (uploader-set), and the reviewer note (public review submission). A value like `=HYPERLINK("http://evil","ok")` or a DDE payload executes when an auditor opens the file in Excel / Sheets.
**Fix:** Prefix any value that starts with `= + - @`, tab, or CR with a single quote, then quote-escape as before.

```ts
const escape = (s: string | null | undefined) => {
  let v = s ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;   // neutralize formula injection
  return `"${v.replace(/"/g, '""')}"`;
};
```

---

### SEC-4 · Database TLS verification disabled by default
**File:** `lib/db/src/index.ts`
**Problem:** With no `DATABASE_CA_CERT`, the pool falls back to `ssl: { rejectUnauthorized: false }`. DigitalOcean Managed PostgreSQL mandates TLS, and unauthenticated TLS is MITM-able. This is the open migration item (remove the `NODE_TLS_REJECT_UNAUTHORIZED=0` workaround and configure the CA cert). Production must fail closed.
**Fix:** Require the cert in production; only allow the insecure fallback in non-production.

```ts
const ca = process.env.DATABASE_CA_CERT;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !ca) {
  throw new Error("DATABASE_CA_CERT must be set in production — refusing to start with unverified TLS.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false },
});
```

Set `DATABASE_CA_CERT` in the DigitalOcean App Platform env (the CA cert is downloadable from the Managed Database connection-details panel), and remove `NODE_TLS_REJECT_UNAUTHORIZED=0` from the environment entirely.

---

### SEC-5 · HTML injection in outbound emails
**File:** `artifacts/api-server/src/routes/emailService.ts` — all three send functions
**Problem:** The export's annotation only flags `signUrl`, but `message`, `doc.title`, `senderName`, and `approvedByNames` are also interpolated raw into the email HTML. `message` comes straight from the `POST /documents/:id/send` body, so a compromised internal account can inject arbitrary markup/links into mail delivered to external recipients (phishing, spoofed buttons, hidden content).
**Fix:** Escape every interpolated value. Add one helper and wrap each `${...}` that contains user/document data.

```ts
function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
```

Then in the templates use `${esc(message || "Please review...")}`, `${esc(doc.title)}`, `${esc(senderName || "E-Sign Workflow")}`, and `${esc(approvedByNames.join(", "))}`. Leave `signUrl` unescaped only inside `href="..."`, but it is already a UUID-derived path so it carries no markup.

---

### SEC-6 · First-registrant-becomes-admin land-grab
**File:** `artifacts/api-server/src/routes/auth.ts` — `/auth/register`
**Problem:** `firstUser.length === 0 ? "admin" : "user"`. On a fresh deploy, whoever reaches `/auth/register` first owns the system. There is also a TOCTOU: two concurrent first registrations can each read zero users and both become admin.
**Fix (pick one):**
- **Preferred:** disable open self-registration and create the first admin out-of-band (seed script or `POST /admin/users` run once via a trusted path), then keep `/auth/register` admin-gated or removed.
- **If open registration must stay:** gate the admin bootstrap behind a one-time `BOOTSTRAP_ADMIN_TOKEN` env var (the registrant must supply the matching token to receive `admin`), and never auto-promote otherwise. This also removes the race.

Either way, do not derive the admin role purely from "the table is empty."

---

### SEC-7 · Account enumeration on login
**File:** `artifacts/api-server/src/routes/auth.ts` — `/auth/login`
**Problem:** Two oracles. (1) Timing: an unknown email returns immediately, a known email runs `bcrypt.compare` (deliberately slow) — measurable difference. (2) Explicit: the "This account uses Microsoft sign-in" branch confirms an email exists.
**Fix:** Run a dummy bcrypt comparison when no user is found, and return one generic error for all "can't sign in with a password" cases.

```ts
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8.../placeholderhashplaceholderhash";

const user = users[0];
if (!user || user.provider !== "local" || !user.password) {
  await bcrypt.compare(password, DUMMY_HASH);          // equalize timing
  res.status(401).json({ error: "Invalid email or password" });
  return;
}
const valid = await bcrypt.compare(password, user.password);
if (!valid) {
  res.status(401).json({ error: "Invalid email or password" });
  return;
}
```

(Generate `DUMMY_HASH` once with `bcrypt.hashSync("x", 10)` and paste the literal.) Lower priority than SEC-1–6, but cheap.

---

## P1 — Functional bugs & hardening

### BUG-1 · Login fails for mixed-case email
**File:** `artifacts/api-server/src/routes/auth.ts` — `/auth/login`
**Problem:** `/register` stores `email.toLowerCase()`, but `/login` queries with the raw input via case-sensitive `eq()`. A user who registered `name@org` and types `Name@org` gets "Invalid email or password." (This is the item the export filed as cosmetic — it is an actual login failure, and a plausible contributor to the registration/login friction you've been chasing.)
**Fix:**

```ts
const { password } = parsed.data;
const email = parsed.data.email.toLowerCase();   // mirror registration
const users = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
```

---

### BUG-2 · Completion race leaves document stuck in "sent"
**File:** `artifacts/api-server/src/routes/signing.ts` — `POST /sign/:token`, completion check
**Problem:** Completion is decided in app code from a `freshRecipients` snapshot using `signers.every(x => x.status === "signed" || x.id === r.id)`. Two simultaneous signers on a `simultaneous` document can each see the other as still `pending`, so neither triggers completion and the document never seals.
**Fix:** Decide completion from a single authoritative DB query inside a transaction, after marking this signer signed.

```ts
const remaining = await db
  .select({ n: count() })            // import { count } from "drizzle-orm"
  .from(recipientsTable)
  .where(and(
    eq(recipientsTable.documentId, r.documentId),
    eq(recipientsTable.requiresSignature, true),
    ne(recipientsTable.status, "signed"),   // import { ne } from "drizzle-orm"
  ));

if (remaining[0].n === 0) {
  // run the existing completion + sealing block
}
```

Wrap the "mark signed" update and this count in a transaction (`db.transaction(async (tx) => { ... })`) so the read reflects this signer's own write and is serialized against concurrent signers.

---

### BUG-3 · Review-only workflow never completes
**File:** `artifacts/api-server/src/routes/signing.ts` — `maybeUnlockSigners`
**Problem:** The document status update is gated on `reviewers.length > 0 && pendingSigners.length > 0`. A review-only document (reviewers, no signers) has `pendingSigners.length === 0`, so it stays in `in_review` forever after all reviewers approve.
**Fix:** When the gate is open and there are no pending signers, set `completed`.

```ts
if (reviewers.length > 0 && pendingSigners.length === 0) {
  await db.update(documentsTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(documentsTable.id, documentId));
} else if (reviewers.length > 0 && pendingSigners.length > 0) {
  await db.update(documentsTable).set({ status: docStatus }).where(eq(documentsTable.id, documentId));
}
```

---

### HARD-1 · Oversized global body limit (unauthenticated DoS)
**File:** `artifacts/api-server/src/app.ts`
**Problem:** `express.json({ limit: "70mb" })` and the matching `urlencoded` run **globally and before auth**, so any unauthenticated client can POST a 70 MB body to any `/api` path (even a 404) and force the parser to buffer it.
**Fix:** Drop the global limit to something small (e.g. `1mb`) and apply a large limit only on the routes that legitimately carry base64 image data (signature save, signature submit).

```ts
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// then on the specific routes:
router.put("/auth/me/signature", express.json({ limit: "1mb" }), handler);
router.post("/sign/:token", express.json({ limit: "2mb" }), signingRateLimit, handler);
```

File uploads already bypass this via multer (50 MB), so documents are unaffected.

---

### HARD-2 · Error handler unreachable behind SPA fallback
**File:** `artifacts/api-server/src/app.ts`
**Problem:** The 4-arg error handler is registered **after** the `/sign`, SPA catch-all, and `express.static` middleware, so errors thrown by `sendFile`/static never reach it and fall through to Express's default handler.
**Fix:** Move the error-handling middleware so it is the last `app.use(...)` in the file, after the SPA catch-all. (It is already written correctly — only its position needs to change.)

---

### HARD-3 · Role changes don't apply until session expiry
**File:** `artifacts/api-server/src/routes/admin.ts` — `requireAdmin` / `requireAuditAccess`, `PATCH /admin/users/:id/role`
**Problem:** Authorization reads `req.session.userRole`, which is frozen at login. A demoted admin keeps admin access for up to 24 h.
**Fix (choose to taste):**
- Cheapest: re-read the role from the DB inside the guards (one indexed `SELECT role WHERE id = session.userId`) instead of trusting the session copy.
- Stronger: on role change, invalidate the affected user's sessions. With `connect-pg-simple` you can `DELETE FROM user_sessions WHERE sess->>'userId' = $1`.

The DB re-read is the smaller change and closes the window immediately.

---

### HARD-4 · No size cap on stored signature data
**File:** `artifacts/api-server/src/routes/auth.ts` — `PUT /auth/me/signature`
**Problem:** The base64 PNG data URL is stored with no explicit cap (only the global body limit guards it). A large payload bloats the `users` row.
**Fix:**

```ts
if (!signatureData || signatureData.length > 300_000) {   // ~200 KB image
  res.status(400).json({ error: "signatureData is required and must be under ~200KB" });
  return;
}
```

Apply the same `.length` guard to `signatureData` in `POST /sign/:token`.

---

### HARD-5 · Field coordinates not bounds-checked
**File:** `artifacts/api-server/src/routes/documents.ts` — `PUT /documents/:id/fields`
**Problem:** `x, y, width, height` from the client are written verbatim; values like `x=1000` or `y=-5` are accepted and later fed to `pdfSigner.ts`, drawing fields off-page.
**Fix:** Validate before insert.

```ts
const inRange = (n: number) => typeof n === "number" && n >= 0 && n <= 1;
for (const f of fields) {
  if (![f.x, f.y, f.width, f.height].every(inRange) ||
      f.x + f.width > 1 || f.y + f.height > 1 ||
      !Number.isInteger(f.page) || f.page < 1) {
    res.status(400).json({ error: "Invalid field geometry" });
    return;
  }
}
```

---

### HARD-6 · Unbounded audit query
**File:** `artifacts/api-server/src/routes/admin.ts` — `buildAuditEvents`
**Problem:** The `recipientsTable` query has no `WHERE` and no `LIMIT`; it loads every recipient row on each audit view/export. Expensive and memory-heavy as data grows.
**Fix:** Restrict recipients to the documents already selected (the query is capped at 500 documents):

```ts
const docIds = documents.map((d) => d.id);
const recipients = docIds.length
  ? await db.select({ /* ...same columns... */ })
      .from(recipientsTable)
      .where(inArray(recipientsTable.documentId, docIds))   // import inArray
  : [];
```

For real scale, paginate `/admin/audit` and `/admin/audit/export` (date-range params) instead of building everything in memory.

---

### HARD-7 · N+1 query listing documents
**File:** `artifacts/api-server/src/routes/documents.ts` — `GET /documents`
**Problem:** One `SELECT` per document to count recipients.
**Fix:** Fetch all recipients for the user's documents in one query and aggregate in code.

```ts
const docIds = docs.map((d) => d.id);
const recs = docIds.length
  ? await db.select().from(recipientsTable).where(inArray(recipientsTable.documentId, docIds))
  : [];
const byDoc = new Map<string, typeof recs>();
for (const r of recs) (byDoc.get(r.documentId) ?? byDoc.set(r.documentId, []).get(r.documentId)!).push(r);
const result = docs.map((doc) => {
  const rs = byDoc.get(doc.id) ?? [];
  return { ...doc, totalRecipients: rs.length, signedCount: rs.filter((r) => r.status === "signed").length };
});
```

---

### S-1 · Streaming errors after headers are sent
**File:** `lib/gcsStorage.ts` — `streamFromGcs` *(VERIFY in the Spaces/S3 rewrite if already migrated)*
**Problem:** Content-Type/Cache-Control are set before piping; if the object stream errors mid-flight the client gets a truncated PDF and no clean error.
**Fix:** For these (small) PDFs, buffer then send so failures surface as a real status code:

```ts
const [buf] = await file.download();
res.set("Content-Type", contentType);
res.set("Cache-Control", "private, max-age=300");
res.send(buf);
```

Or, longer term, issue short-lived signed object URLs and redirect, keeping large files off the app's heap.

---

### S-2 · `fileExists` blindly returns true for object storage
**File:** `lib/gcsStorage.ts` callers in `documents.ts` and `signing.ts` *(VERIFY in S3 rewrite)*
**Problem:** `if (isGcsPath(filepath)) return true;` — a document whose object was deleted/never uploaded passes the existence check, then the download throws mid-request instead of returning 404.
**Fix:** Either do a real existence check (`file.exists()` / S3 `HeadObject`) before streaming, or catch the download/stream error and translate it to a 404 in the route's `catch`.

---

### S-3 · Orphaned objects on document delete
**File:** `artifacts/api-server/src/routes/documents.ts` — `DELETE /documents/:id` *(VERIFY in S3 rewrite)*
**Problem:** The DB rows are deleted but the stored PDF object is not, accumulating orphans.
**Fix:** After the DB deletes, delete the object (`bucket.file(objectName).delete()` / S3 `DeleteObject`), wrapped in try/catch so a missing object doesn't fail the request. Also delete the sealed object if `sealedPdfPath` is set.

---

### HARD-8 · Email transporter created eagerly
**File:** `artifacts/api-server/src/routes/emailService.ts`
**Problem:** `nodemailer.createTransport` runs at import time pointing at `smtp.gmail.com` even when SMTP is unconfigured; fragile if DNS fails at startup, and the hardcoded default can mask a misconfigured `SMTP_HOST`.
**Fix:** Make it lazy and inert when unconfigured.

```ts
let _transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!smtpConfigured()) return null;
  if (!_transporter) _transporter = nodemailer.createTransport({ /* ...config... */ });
  return _transporter;
}
```

Each send function already early-returns when `!smtpConfigured()`, so this is a clean drop-in.

---

### HARD-9 · Upload accepts any bytes with a `.pdf` name
**File:** `artifacts/api-server/src/routes/documents.ts` — multer `fileFilter`
**Problem:** The filter checks only the filename extension, not content. A non-PDF named `x.pdf` is stored and later served as `application/pdf` (pdf-lib then throws at sign time).
**Fix:** After upload, validate the magic header before persisting:

```ts
if (!pdfBuffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
  res.status(400).json({ error: "File is not a valid PDF" });
  return;
}
```

(The served `Content-Type` is fixed to `application/pdf`, so this is robustness, not an active XSS path — but it prevents storing junk.)

---

### HARD-10 · `/sign/:token` returns the full recipient row
**File:** `artifacts/api-server/src/routes/signing.ts` — `GET /sign/:token`
**Problem:** `res.json({ recipient: r, ... })` returns every column of the recipient row, and on a completed document `allSignedFields` exposes every co-signer's field values (including signature images) to any single token holder. Mostly by-design for co-signed docs, but it's loose data minimization and will silently leak any sensitive column added later.
**Fix:** Select only the fields the signing UI needs (`id, documentId, teamName, email, status, signOrder, requiresReview, requiresSignature, reviewStatus, tokenExpiresAt`) rather than `select()` of the whole row, and gate `allSignedFields` to fields owned by signers the token holder is entitled to see.

---

## P2 — Cleanup & consistency

### CLN-1 · ReviewPage bypasses the generated API client
**File:** `artifacts/esign-app/src/pages/review.tsx`
Uses raw `fetch()` while the rest of the app uses generated TanStack Query hooks. Migrate to `useGetSigningInfo()` plus a generated review mutation for consistent error handling and caching.

### CLN-2 · "sent" audit timestamp is inaccurate
**File:** `artifacts/api-server/src/routes/admin.ts` — `buildAuditEvents`
The synthesized "sent" event uses `document.createdAt`, so a draft sent later shows the wrong send time. Add a real `sentAt` column to `documents`, set it in `POST /documents/:id/send`, and use it here.

### CLN-3 · Stale DOCX documentation
**File:** project docs (`replit.md`)
Server accepts PDF only; DOCX/LibreOffice conversion was removed. Update `replit.md` so it doesn't advertise a removed feature.

---

## Suggested order of work

1. **SEC-4** (DB TLS) and **HARD-1** (body limit) — infra/config, do as part of the DigitalOcean env setup.
2. **SEC-1, SEC-2, SEC-3, SEC-5** — the four code-level security fixes; small, high-value, low-risk.
3. **BUG-1** (login case) — likely resolves real login friction; one line.
4. **SEC-6, SEC-7** — registration hardening.
5. **BUG-2, BUG-3** — completion/seal correctness (BUG-2 needs the transaction; test with concurrent signers).
6. **HARD-2 → HARD-10**, **S-1 → S-3** — hardening pass; fold S-1/S-2/S-3 into the Spaces rewrite if it's mid-flight.
7. **CLN-1 → CLN-3** — schedule separately.

### Tracking checklist
- [ ] SEC-1 Session regeneration on login/register/azure
- [ ] SEC-2 `req.ip` for signature + review IP
- [ ] SEC-3 CSV formula-prefix neutralization
- [ ] SEC-4 Require `DATABASE_CA_CERT` in prod; remove `NODE_TLS_REJECT_UNAUTHORIZED=0`
- [ ] SEC-5 Escape interpolated email fields
- [ ] SEC-6 Remove first-user-admin land-grab
- [ ] SEC-7 Constant-time login + generic error
- [ ] BUG-1 Lowercase login email
- [ ] BUG-2 Transactional completion check
- [ ] BUG-3 Complete review-only documents
- [ ] HARD-1..10 hardening
- [ ] S-1..3 storage layer (apply in Spaces rewrite)
- [ ] CLN-1..3 cleanup

---

*Items marked **VERIFY** rest on files that were summarized rather than shown in full in the source export (`pdfSigner.ts` internals, `/sign/:token/file`, the frontend pages). Confirm against the live code before applying. This review found no IDOR on the authenticated routes and no signature-verification flaw in the Azure flow as used.*
