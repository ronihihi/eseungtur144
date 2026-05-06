# WorkflowSign

A full-stack DocuSign-style e-signature app where teams upload PDFs, place signature field boxes per recipient, and collect legally tracked signatures via unique email links — with inline PDF viewing throughout.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at `/api`)
- `pnpm --filter @workspace/esign-app run dev` — run the React frontend (served at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (auto-provisioned)
- Required env: `SESSION_SECRET` — already set in secrets
- Optional env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — for sending real emails
- Optional env: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — enables Microsoft SSO button
- Optional env: `AZURE_REDIRECT_URI` — override OAuth callback URL (defaults to `{host}/api/auth/azure/callback`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + express-session (session-based auth)
- DB: PostgreSQL + Drizzle ORM
- Auth: bcryptjs password hashing, express-session; Azure AD OAuth2 (raw fetch, no extra lib)
- Email: nodemailer (SMTP; skips silently if not configured)
- File uploads: base64 JSON → server decodes → saves to GCS (Google Cloud Storage via Replit Object Storage)
- PDF viewer: react-pdf (pdfjs-dist worker served from `public/pdf.worker.min.mjs`)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Frontend: React + Vite + TanStack Query + wouter + shadcn/ui
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle table definitions (users, documents, recipients, signatureFields)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/esign-app/src/` — React frontend (pages, components)
- `artifacts/esign-app/src/components/pdf-viewer.tsx` — reusable PDF viewer with overlay support
- `artifacts/esign-app/src/components/saved-signature-dialog.tsx` — saved signature management dialog
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — generated Zod schemas (do not edit)

## Architecture decisions

- Session-based auth (express-session + bcryptjs) instead of JWT — simpler for this use case
- `orval.config.ts` uses `indexFiles: false` for the Zod output to avoid duplicate export conflicts
- File uploads stored in GCS (Replit Object Storage); `filepath` in DB holds a `gcs://bucket-id/object-name` URI; old local paths still served from disk for backward compat
- SMTP email is optional — if not configured, email sends are skipped with a warning log
- PDF served via authenticated `/api/documents/:id/file` (session cookie) or public `/api/sign/:token/file` (token in URL)
- Signed PDF download via `/api/documents/:id/download` (auth) or `/api/sign/:token/download` (public) — uses pdf-lib to burn signature images + signer name + date directly into the PDF file at download time; falls back gracefully if no signatures collected yet
- pdfjs worker copied to `artifacts/esign-app/public/pdf.worker.min.mjs` (cdnjs doesn't carry pdfjs v5); referenced as `/pdf.worker.min.mjs`
- DOCX/DOC uploads auto-converted to PDF at upload time via LibreOffice (`soffice --headless --convert-to pdf`); original DOCX deleted after conversion; uses per-request temp profile dir to avoid lock conflicts
- Multiple fields per recipient — unlimited; drag field type from palette and drop onto PDF to place; click placed field to remove
- Four field types: `signature` (drawn pad → PNG image in PDF), `initials` (drawn pad), `date` (date input, pre-filled today), `text` (free text input)
- Signature fields stored as 0–1 fractional coordinates (x, y, width, height) of page dimensions — renders with `position: absolute` percentage-based CSS
- All `req.params.*` values must be cast `as string` when used in Drizzle `eq()` — Express types them as `string | string[]`

## Product

- User registration and login (session-based)
- Upload PDF or DOCX/DOC documents (up to 50MB); Word docs are auto-converted to PDF on the server via LibreOffice
- **PDF viewer inline** — document detail page shows the live PDF with react-pdf
- **Signature field placement** — drag field types (Signature, Initials, Date, Text) from palette onto PDF per recipient; multiple fields per person allowed; fields saved to DB as fractional page coordinates
- Add up to 7 team recipients with names and email addresses
- Choose sequential (one-by-one) or simultaneous signing
- Email sent to recipients with unique per-recipient signing link
- **Public signing page** — shows PDF with recipient's field highlighted; recipient draws signature inline
- **Saved signature** — logged-in users can save their signature (pen icon in header); available as "Use saved" shortcut on signing page
- Real-time signing progress tracked per document
- Send reminders to pending recipients; copy signing links
- Full audit trail (signed-at timestamp, signer name, IP address)
- **Signed PDF download** — Download button on both the document detail page and the signing confirmation page produces a PDF with all collected signatures burned in (signature image + signer name + date embedded via pdf-lib); if a field was placed, the signature overlays the field box; if no field, a signature block is appended at the foot of the last page

## User preferences

- DocuSign-style field placement: click PDF to stamp signature box; each recipient gets exactly one field (clicking moves it)

## Gotchas

- Always run codegen before using generated hooks: `pnpm --filter @workspace/api-spec run codegen`
- Do NOT add `schemas:` back to the `zod` output in `orval.config.ts` — it causes duplicate export conflicts
- `lib/api-zod/src/index.ts` must only export from `./generated/api` (not types)
- Sessions use cookies — CORS `credentials: true`; frontend must use `credentials: "include"` in fetches
- `useGetDocumentStatus`, `useGetSavedSignature`, and similar hooks require explicit `queryKey` in their options

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Signing flow: recipient gets email → opens `/sign/:token` → views PDF with highlighted field → draws signature → submits
- Field placement flow: admin uploads doc → adds recipients → clicks PDF to place fields per recipient → saves fields → sends for signature
