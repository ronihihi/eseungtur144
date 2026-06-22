# Infrastructure Export Prompt — for Replit AI Agent

> **How to use:** Paste everything below the line into the Replit AI Agent on the app you want documented. The Agent will read the real codebase and produce a single markdown file. It is written to pull **ground truth from the code**, not guesses, and to go deep on the two areas you care about most: the **signature process** and **data encryption**.

---

## ROLE

You are a senior infrastructure and application-security engineer. Your job is to produce a complete, accurate technical export of this application's infrastructure for a production-readiness and security review. The reader is technical and needs precision, not marketing.

## MISSION

Read this entire repository and produce **one markdown document** named `INFRASTRUCTURE.md`, saved at the repo root, that fully documents how this application is built, runs, stores data, signs records, and protects data. Every claim must trace back to a real file, function, config value, or environment variable in this repo.

## NON-NEGOTIABLE RULES

1. **Ground truth only.** Document what the code actually does. Do not describe intended or "typical" behaviour. If something is configured but unused, say so.
2. **Cite the source.** For every meaningful statement, reference the file path and, where useful, the function or line (e.g. `server/routes/sign.ts → signRecord()`). 
3. **Distinguish implemented vs planned.** Tag each item as `[IMPLEMENTED]`, `[PARTIAL]`, or `[PLANNED]`. The storage layer is mid-migration (file-based → PostgreSQL); make the current vs target state explicit everywhere it matters.
4. **Redact secrets.** Never print actual secret values, keys, tokens, or credentials. Show the variable name, where it is read, and how it is used — value as `«redacted»`.
5. **Encoding is not encryption.** If you find Base64, hex, or URL-encoding being treated as if it protected data, flag it explicitly as **NOT encryption**.
6. **Flag gaps and risks inline.** When you find a missing control, weak setting, or hardcoded secret, mark it `⚠️ RISK:` with a one-line explanation and a recommended fix.
7. **No hallucinated dependencies.** Only list libraries that appear in `package.json` / lockfiles or are actually imported.

## DELIVERABLE FORMAT

- A single `INFRASTRUCTURE.md` at the repo root.
- Use the section structure in **DOCUMENT OUTLINE** below, in that order.
- Use Markdown tables for inventories (endpoints, env vars, dependencies).
- Include **Mermaid diagrams** for: (a) high-level architecture, (b) the signature generation + verification flow, (c) the request data-flow showing where encryption applies.
- Keep prose tight. Favour tables, bullet facts, and diagrams over paragraphs.

---

## DOCUMENT OUTLINE (produce every section)

### 1. System Overview
One short paragraph: what the app does, who uses it, and the runtime shape (SPA + API, etc.).

### 2. Tech Stack & Versions
Table of every runtime, framework, and major library with its **exact version** from the lockfile. Columns: Layer | Package | Version | Purpose.

### 3. Repository Structure
A tree of the meaningful directories (skip `node_modules`, build output) with a one-line note on what each top-level folder holds.

### 4. Runtime & Hosting (Replit specifics)
- How the app boots (entry file, scripts in `package.json`, `.replit` / `replit.nix` config).
- Ports, host binding, dev vs production start commands.
- Build pipeline (Vite build, Express serving static assets, etc.).
- Anything Replit-managed: TLS termination, the public URL, always-on/deployment type, Replit Secrets usage.

### 5. Frontend Architecture
- Framework, router, state management, build tool config.
- How it talks to the API (base URL, fetch/axios wrapper, auth header/cookie handling).
- Any client-side handling of sensitive data (and whether it should be there).

### 6. Backend Architecture
- Server framework and middleware stack **in order** (list every `app.use(...)`).
- Route organisation and how requests are validated.
- Error handling and logging.

### 7. Data Layer & Storage  `[track IMPLEMENTED vs PLANNED carefully here]`
- **Current:** the file-based store — which files, formats, read/write paths, concurrency handling, where on disk, what happens on restart.
- **Target:** the planned PostgreSQL design — schema, ORM/driver, migration approach — to whatever degree it exists in the repo.
- Data integrity: is the store append-only? mutable? how are records identified?

### 8. Data Model / Schemas
For each core entity, list its fields, types, and which fields are sensitive (PII, credentials, signatures, audit data).

### 9. API Surface
Full endpoint inventory table. Columns: Method | Path | Auth required? | Purpose | Handler (file → function) | Sensitive data touched.

### 10. Authentication & Session Management
- How users authenticate (mechanism, library).
- Session/token model: cookie session vs JWT, where the session secret comes from, expiry, refresh.
- Logout/invalidation behaviour.

### 11. ⭐ Digital Signature Process  (DEEP DIVE — see SIGNATURE SPEC below)

### 12. ⭐ Encryption & Data Protection  (DEEP DIVE — see ENCRYPTION SPEC below)

### 13. Secrets & Environment Variables
Table of every env var the app reads. Columns: Variable | Where read (file) | Purpose | Required? | Has safe default? | Stored in Replit Secrets? Mark `⚠️ RISK:` any secret with a hardcoded fallback or committed value.

### 14. Audit Trail Mechanism
- What events are recorded, the record shape, and where stored.
- Immutability / tamper-evidence guarantees (and how they're enforced).
- Export and dashboard surfaces, if present.

### 15. Third-Party Services & Integrations
External APIs, SMTP, storage, analytics — with how each is authenticated.

### 16. Security Posture Summary
A checklist table covering: HTTPS/HSTS, Helmet config, CSP directives (list them), cookie flags (Secure/HttpOnly/SameSite), CORS policy, rate limiting, input validation, tabnabbing/`rel=noopener`, dependency vulnerabilities. Mark each ✅ / ⚠️ / ❌ with the source.

### 17. Known Gaps, Risks & Recommendations
Consolidated, prioritised table of every `⚠️ RISK:` found, ranked High/Medium/Low, each with a concrete remediation.

### 18. Appendices
The three Mermaid diagrams, plus any config excerpts (with secrets redacted).

---

## ⭐ SIGNATURE SPEC — answer ALL of these in Section 11

Document the signing mechanism exactly as implemented. If **both** a cryptographic signature (record integrity) and a user e-signature (a person signing/approving something) exist, document each separately.

**A. Trigger & purpose**
- What action causes a signature to be created? On which entity/event?
- What is the signature meant to prove — integrity, authenticity, approval, non-repudiation?

**B. What gets signed (the payload)**
- The exact fields included in the signed payload, in order.
- The canonicalisation: how is the object serialised before signing (JSON.stringify? sorted keys? a concatenated string)? Is it deterministic? `⚠️` if not — non-deterministic input breaks verification.

**C. Algorithm & keys**
- Signing scheme: HMAC (which hash — SHA-256?) vs asymmetric (RSA, ECDSA, Ed25519). Quote the `node:crypto` / library calls.
- Where the key/secret comes from (env var name, generation, storage).
- Key length, rotation story, and whether the same secret signs and verifies (symmetric) or there's a keypair (asymmetric).
- `⚠️ RISK:` if the signing key is hardcoded, weak, committed, or shared with the session secret.

**D. Generation flow — step by step**
Walk the actual call path, file by file and function by function, from trigger → payload assembly → hash/sign → output. Number each step.

**E. Output & storage**
- Encoding of the signature (hex / base64).
- Where it is stored and against which record.
- Is a timestamp signed in? Is signer identity bound into it?

**F. Verification flow — step by step**
- When/where verification runs.
- How the payload is re-derived and compared.
- Constant-time comparison used? (`crypto.timingSafeEqual`?) `⚠️` if a plain `===` is used on a MAC.
- What happens on failure.

**G. Tamper-evidence / chaining**
- Does each record include the hash/signature of the previous record (hash chain / ledger)? If so, document the chain and how a break is detected.
- Replay protection, nonce/sequence handling.

**H. Weaknesses**
List every signature-related `⚠️ RISK:` (e.g. signing key reuse, non-canonical payload, missing verification on read, MD5/SHA-1 usage, signature not covering all mutable fields).

Then render the **signature Mermaid diagram** (generation + verification).

---

## ⭐ ENCRYPTION SPEC — answer ALL of these in Section 12

**A. Data in transit**
- Is the app served over HTTPS? Who terminates TLS (Replit)? 
- HSTS present (via Helmet)? Max-age, includeSubDomains, preload?
- Is HTTP redirected to HTTPS, or can it serve plaintext? `⚠️` if plaintext is reachable.
- TLS for outbound calls (DB, SMTP, third-party).

**B. Data at rest**
- Current file-based store: is anything on disk encrypted, or is it plaintext JSON? State plainly. `⚠️ RISK:` if PII/credentials sit in plaintext files.
- Planned PostgreSQL: any column-level or at-rest encryption planned/configured?
- Backups: are they encrypted?

**C. Passwords & credentials**
- Hashing algorithm for passwords (bcrypt / argon2 / scrypt). Quote the call and the cost/work factor.
- Per-user salt? `⚠️ RISK:` if passwords are stored plaintext, encrypted-but-reversible, or hashed with MD5/SHA-1/unsalted SHA-256.

**D. Sensitive field protection**
- Any field-level encryption of PII or sensitive business data? Algorithm (e.g. AES-256-GCM), mode, IV handling, auth tag handling.
- `⚠️` if ECB mode, a static/reused IV, or a missing auth tag.

**E. Secrets management**
- Where secrets live: Replit Secrets, `.env`, hardcoded.
- `⚠️ RISK:` for any secret committed to the repo or with an insecure fallback (`process.env.X || 'devsecret'`).
- Key/secret rotation approach.

**F. Cookies & session crypto**
- Cookie flags actually set: `Secure`, `HttpOnly`, `SameSite` (value), `Path`, `Max-Age`.
- Are cookies signed/encrypted? Where does the session secret come from?

**G. Crypto libraries & primitives**
- Every crypto-related library/import in use, with version.
- Any custom/hand-rolled crypto? `⚠️ RISK:` — flag and recommend a vetted library.

**H. Encoding-masquerading-as-encryption check**
- Explicitly state anywhere Base64/hex/encoding is used in a place where real encryption is expected, and mark it **NOT encryption**.

Then render the **data-flow Mermaid diagram** showing where encryption applies (browser ⇄ TLS ⇄ Express ⇄ store) and where it does not.

---

## FINAL CHECKLIST (run before you finish)

- [ ] Every section above is present and filled from real code.
- [ ] Signature Spec items A–H all answered, with the generation+verification diagram.
- [ ] Encryption Spec items A–H all answered, with the data-flow diagram.
- [ ] Every secret is `«redacted»`; none printed.
- [ ] Every claim cites a file/function.
- [ ] Implemented vs Planned tagged throughout (especially storage).
- [ ] All `⚠️ RISK:` items consolidated and prioritised in Section 17.
- [ ] Saved as `INFRASTRUCTURE.md` at the repo root.

When done, reply in chat with a 5-line summary: stack, storage state, signature scheme, encryption posture, and the count of High-risk findings.
