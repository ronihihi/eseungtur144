# WorkflowSign — Environment Variables Reference

All variables needed for a DigitalOcean App Platform deployment.  
Mark every `SECRET` row as **Encrypted** in the DO dashboard.

---

## Required — app will not start without these

| Variable | Example / Notes | Secret? |
|---|---|---|
| `NODE_ENV` | `production` | No |
| `PORT` | `8080` | No |
| `DATABASE_URL` | `${db.DATABASE_URL}` (DO binding) | **Yes** |
| `DATABASE_CA_CERT` | `${db.CA_CERT}` (DO binding) | No |
| `SESSION_SECRET` | 64-char hex — `openssl rand -hex 32` | **Yes** |
| `APP_URL` | `https://workflowsign.ondigitalocean.app` | No |
| `APP_ORIGIN` | Same as `APP_URL` (or comma-separated list if multiple frontends) | No |
| `GCP_SA_KEY_B64` | Base64-encoded GCP service account JSON key — `base64 -w0 sa.json` | **Yes** |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Your GCS bucket name | No |

---

## Optional — email (SMTP)

Leave blank to disable outbound email (signing links won't be emailed; you can still copy them manually).

| Variable | Example | Secret? |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | **Yes** |
| `SMTP_PORT` | `587` | **Yes** |
| `SMTP_USER` | `noreply@example.org` | **Yes** |
| `SMTP_PASS` | app password / API key | **Yes** |

---

## Optional — Microsoft SSO (Azure AD)

Leave blank to hide the "Sign in with Microsoft" button.

| Variable | Where to find it | Secret? |
|---|---|---|
| `AZURE_TENANT_ID` | Azure portal → App registration → Overview | **Yes** |
| `AZURE_CLIENT_ID` | Same page | **Yes** |
| `AZURE_CLIENT_SECRET` | Azure portal → Certificates & secrets | **Yes** |
| `AZURE_REDIRECT_URI` | Override only if needed — defaults to `{APP_URL}/api/auth/azure/callback` | No |

---

## Optional — logging

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | One of: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

---

## Do NOT set on DigitalOcean

These are Replit-specific and will never be present on DO.

| Variable | Why it was there |
|---|---|
| `REPLIT_DOMAINS` | Replit reverse-proxy domain list — replaced by `APP_URL` |
| `REPL_ID` | Replit workspace identifier — used to gate dev-only Vite plugins |
| `PRIVATE_OBJECT_DIR` | Replit Object Storage path — replaced by GCS |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Same |

---

## `.env` template (local dev)

Copy to `.env` and fill in your values. Never commit this file.

```env
NODE_ENV=development
PORT=8080

# PostgreSQL (local dev — no SSL needed)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workflowsign
# DATABASE_CA_CERT=   # leave blank for local dev

# Sessions
SESSION_SECRET=change-me-generate-with-openssl-rand-hex-32

# App URLs
APP_URL=http://localhost:8080
APP_ORIGIN=http://localhost:5173,http://localhost:8080

# GCS file storage (leave blank to skip uploads in dev)
GCP_SA_KEY_B64=
DEFAULT_OBJECT_STORAGE_BUCKET_ID=

# Email (leave blank to skip in dev)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=

# Azure SSO (leave blank to hide button)
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
# AZURE_REDIRECT_URI=

# Logging
# LOG_LEVEL=debug
```
