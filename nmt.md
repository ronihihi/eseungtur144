# WorkflowSign — System Overview

## What is it?

WorkflowSign is a web-based e-signature platform built for SOS Children's Villages Palestine. It lets staff upload documents (PDF or Word), assign them to one or more people for signing, and collect legally traceable signatures through unique email links — all without needing a third-party service like DocuSign.

---

## Who uses it?

| Role | What they can do |
|------|-----------------|
| **Admin** | Register users, reset passwords, manage all documents, see all activity |
| **Regular user** | Upload documents, assign recipients, track signing progress, download signed PDFs |
| **Recipient (signer)** | Receives an email link, opens the document, draws their signature — no account needed |

---

## How a document gets signed (step by step)

1. A user logs in and uploads a PDF or Word document (up to 50 MB; Word files are auto-converted to PDF).
2. They add recipients — each recipient gets a name and email address (up to 7 people).
3. They drag signature field boxes onto the PDF pages for each recipient.
4. They choose **sequential** (one person signs, then the next) or **simultaneous** (everyone gets the link at the same time).
5. They click **Send** — each recipient receives an email with a unique private link.
6. The recipient opens their link, sees the PDF with their field highlighted, draws their signature with their finger or mouse, and submits.
7. The document owner can track progress, send reminders, and copy signing links manually if email is not configured.
8. Once all signatures are collected, anyone can download the **signed PDF** — the signatures are burned directly into the file.

---

## Accounts and login

- Accounts are created by an admin (self-registration is not available to the public).
- Login is email + password.
- **Microsoft (Azure) SSO** is available — users can sign in with their organisation Microsoft account if configured.
- When an admin resets a user's password, the user is forced to set a new password on their next login before they can do anything else.

---

## Where files are stored

Uploaded documents and converted PDFs are stored in **DigitalOcean Spaces** (cloud object storage), not on the server's local disk. This means files survive server restarts and deployments.

---

## Database

All data — users, documents, recipients, signature fields, audit events — is stored in a **PostgreSQL database** hosted on DigitalOcean Managed Databases.

Key tables:

| Table | What it holds |
|-------|--------------|
| `users` | Accounts, hashed passwords, roles |
| `documents` | Uploaded file metadata, status |
| `recipients` | People assigned to sign a document + unique token |
| `signature_fields` | Where on the PDF each person's field is placed |
| `signature_field_values` | The actual collected signature data |
| `document_activity` | Full audit trail (who did what, when, from which IP) |
| `password_reset_tokens` | One-time tokens for self-service password reset |

---

## Email

Email is sent via SMTP (configured through environment variables). It is used for:

- Sending signing links to recipients
- Self-service "forgot password" emails

If SMTP is not configured, email is silently skipped — signing links can still be copied and sent manually from the admin panel.

---

## Security highlights

- Passwords are hashed with bcrypt (never stored in plain text).
- Each recipient has a unique random token — their link works only for their specific document.
- Session cookies are used for logged-in users (not long-lived tokens).
- Every document action is logged in the audit trail with timestamps and IP addresses.
- Rate limiting is applied to login attempts (20 attempts per 15 minutes before lockout).
- File access requires either a valid session (for the document owner) or a valid recipient token.

---

## Deployment

The application is deployed on **DigitalOcean App Platform** at:

> https://seashell-app-dtiyh.ondigitalocean.app

It runs as two services:
- **API server** — Express.js backend (handles all data, file operations, email, authentication)
- **Web app** — React frontend (what users see in the browser)

Code is stored on GitHub and automatically deployed when changes are pushed to the `main` branch.

---

## Technology stack (for technical reference)

| Layer | Technology |
|-------|-----------|
| Frontend | React, Vite, TanStack Query, shadcn/ui |
| Backend | Node.js, Express |
| Database | PostgreSQL + Drizzle ORM |
| File storage | DigitalOcean Spaces (S3-compatible) |
| PDF rendering | react-pdf (pdfjs) |
| PDF signing | pdf-lib (burns signatures into the file) |
| Word conversion | LibreOffice (server-side, headless) |
| Auth | bcryptjs sessions + optional Azure OAuth |
| Email | Nodemailer (SMTP) |
