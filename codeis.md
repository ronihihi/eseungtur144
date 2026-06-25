# WorkflowSign — Full Source Code Export
**Exported:** 2026-06-25  
**Purpose:** Complete code review for migration to DigitalOcean App Platform.  
**Organization:** SOS Children's Villages Palestine  

---

## Bug Annotation Key

| Tag | Meaning |
|-----|---------|
| `🐛 BUG` | Functional defect — incorrect behaviour that can be observed |
| `⚠️ WARNING` | Design concern — not broken today but fragile under load, concurrency, or edge cases |
| `🔐 SECURITY` | Security-relevant pattern worth auditing |
| `📝 NOTE` | Informational — explains a non-obvious design decision |

---

## Table of Contents

1. [Database Schema](#1-database-schema)
2. [API Server — Infrastructure](#2-api-server--infrastructure)
3. [API Server — Routes](#3-api-server--routes)
4. [Frontend — Entry Points & Router](#4-frontend--entry-points--router)
5. [Frontend — Pages](#5-frontend--pages)
6. [Frontend — Components](#6-frontend--components)

---

## 1. Database Schema

### `lib/db/src/index.ts`

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const ca = process.env.DATABASE_CA_CERT;

// 📝 NOTE: DATABASE_CA_CERT enables mutual TLS verification against DigitalOcean
// managed PostgreSQL. When unset, rejectUnauthorized:false is used (less secure
// but works for non-TLS Postgres). In production always set DATABASE_CA_CERT.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: ca
    ? { rejectUnauthorized: true, ca }
    : { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });

export * from "./schema";
```

---

### `lib/db/src/schema/users.ts`

```typescript
import { pgTable, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  password: text("password"), // nullable for Azure SSO users
  role: text("role").notNull().default("user"),
  provider: text("provider").notNull().default("local"), // 'local' | 'azure'
  azureId: text("azure_id").unique(),
  signatureData: text("signature_data"),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  emailCiUniq: uniqueIndex("users_email_ci_uniq").on(sql`lower(${t.email})`),
}));

// 📝 NOTE: Case-insensitive unique index on email (lower()) prevents duplicate
// accounts with mixed case. This matches the lowercase normalization done at
// registration and login time.

export const insertUserSchema = createInsertSchema(usersTable).omit({
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
```

---

### `lib/db/src/schema/documents.ts`

```typescript
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const documentsTable = pgTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  filename: text("filename").notNull(),
  filepath: text("filepath").notNull(), // gcs://bucket-id/object-name or legacy local path
  uploadedBy: text("uploaded_by").notNull(),
  uploaderName: text("uploader_name").notNull(),
  signingOrder: text("signing_order").notNull().default("simultaneous"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  sealedPdfPath: text("sealed_pdf_path"),  // GCS path to pre-built sealed PDF
  sealedPdfHash: text("sealed_pdf_hash"),  // SHA-256 of sealed PDF bytes
});

// 📝 NOTE: sealedPdfPath/sealedPdfHash are written when the last signer signs.
// Download endpoint uses the pre-sealed PDF if available; falls back to
// on-demand generation if GCS upload failed.

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({
  createdAt: true,
  completedAt: true,
  sealedPdfPath: true,
  sealedPdfHash: true,
});
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
```

---

### `lib/db/src/schema/recipients.ts`

```typescript
import { pgTable, text, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recipientsTable = pgTable("recipients", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  teamName: text("team_name").notNull(),
  email: text("email").notNull(),
  signOrder: integer("sign_order").notNull(),
  status: text("status").notNull().default("pending"), // pending | viewed | signed
  token: text("token").notNull().unique(),
  signerName: text("signer_name"),
  ipAddress: text("ip_address"),
  signatureData: text("signature_data"),
  viewedAt: timestamp("viewed_at"),
  signedAt: timestamp("signed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  requiresReview: boolean("requires_review").notNull().default(false),
  requiresSignature: boolean("requires_signature").notNull().default(true),
  reviewStatus: text("review_status"),  // null | pending | approved | changes_requested
  reviewedAt: timestamp("reviewed_at"),
  reviewNote: text("review_note"),
  reviewChecklist: jsonb("review_checklist"),
  tokenExpiresAt: timestamp("token_expires_at"),  // 90 days from creation
});

// ⚠️ WARNING: email is not lowercased at DB level. If a recipient email is
// stored mixed-case, the /signing/my-requests endpoint (which filters by
// session.userEmail.toLowerCase()) may miss it. The sign flow itself is
// token-based so this doesn't affect signing, only the "awaiting my signature"
// dashboard widget.

export const insertRecipientSchema = createInsertSchema(recipientsTable).omit({
  createdAt: true,
  viewedAt: true,
  signedAt: true,
  signerName: true,
  ipAddress: true,
  signatureData: true,
  reviewedAt: true,
  reviewNote: true,
  reviewChecklist: true,
});
export type InsertRecipient = z.infer<typeof insertRecipientSchema>;
export type Recipient = typeof recipientsTable.$inferSelect;
```

---

### `lib/db/src/schema/signatureFields.ts`

```typescript
import { pgTable, text, timestamp, integer, real } from "drizzle-orm/pg-core";

export const signatureFieldsTable = pgTable("signature_fields", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  recipientId: text("recipient_id").notNull(),
  page: integer("page").notNull().default(1),
  x: real("x").notNull().default(0.1),        // fractional [0–1] of page width
  y: real("y").notNull().default(0.85),       // fractional [0–1] of page height (top-down)
  width: real("width").notNull().default(0.3),
  height: real("height").notNull().default(0.07),
  fieldType: text("field_type").notNull().default("signature"), // signature | initials | date | text
  fieldValue: text("field_value"),  // filled in when recipient signs
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 📝 NOTE: Coordinates are stored as [0–1] fractions of page dimensions.
// The frontend renders them with position:absolute percentage CSS.
// pdfSigner.ts converts them to pdf-lib drawing coordinates (bottom-left
// origin, MediaBox units) accounting for page rotation.

export type SignatureField = typeof signatureFieldsTable.$inferSelect;
```

---

### `lib/db/src/schema/documentEvents.ts`

```typescript
import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const documentEventsTable = pgTable("document_events", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  recipientId: text("recipient_id"),
  eventType: text("event_type").notNull(), // uploaded | sent | viewed | signed | completed | sealed | review_approved | review_changes_requested
  actorName: text("actor_name"),
  actorEmail: text("actor_email"),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 📝 NOTE: This table is written to by signing.ts (insertEvent helper).
// The admin audit log at /admin/audit does NOT use this table — it builds
// events manually from documentsTable + recipientsTable queries in
// buildAuditEvents(). The two audit systems are independent.

export type DocumentEvent = typeof documentEventsTable.$inferSelect;
```

---

### `lib/db/src/schema/index.ts`

_(re-exports all tables — not shown separately; standard barrel file)_

---

## 2. API Server — Infrastructure

### `artifacts/api-server/src/lib/logger.ts`

```typescript
import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  // 📝 NOTE: pino-pretty for development, structured JSON for production.
  // Sensitive headers (cookie, authorization, set-cookie) are redacted in all modes.
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
```

---

### `artifacts/api-server/src/lib/rateLimiters.ts`

```typescript
import { rateLimit } from "express-rate-limit";

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again later" },
});

// 📝 NOTE: authRateLimit applied to /auth/register, /auth/login, /auth/azure.
// 30 req / 15 min per IP is reasonable for login/register flows.

export const signingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again later" },
});

// ⚠️ WARNING: signingRateLimit (60/15min) is applied to all public /sign/:token
// routes including GET (info fetch), POST (submit), file download, and review
// submission. 60 requests per 15 minutes per IP is generous. Consider tightening
// the POST submit limit specifically, or using token-based limiting instead of IP
// since multiple users behind a NAT share the same IP.
```

---

### `artifacts/api-server/src/lib/appUrl.ts`

```typescript
import type { Request } from "express";

// 📝 NOTE: APP_URL env var takes precedence over request-derived URL.
// app.set("trust proxy", 1) in app.ts ensures req.protocol reflects the
// upstream HTTPS from the DO load balancer. Without trust proxy, protocol
// would always be "http" even when the client connected over HTTPS.
export function getAppBaseUrl(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const protocol = req.protocol || "https";
  const host = req.get("host") || "localhost";
  return `${protocol}://${host}`;
}
```

---

### `artifacts/api-server/src/lib/gcsStorage.ts`

```typescript
import { Storage } from "@google-cloud/storage";
import type { Response } from "express";

// 📝 NOTE: Lazy singleton — GCS client is created on first use, not at import
// time. This avoids startup failures when GCP_SA_KEY_B64 is not set in
// development or health-check-only deployments.
let _gcsClient: Storage | null = null;

function getGcsClient(): Storage {
  if (_gcsClient) return _gcsClient;
  const b64 = process.env.GCP_SA_KEY_B64;
  if (!b64) throw new Error("GCP_SA_KEY_B64 is not set — file storage is unavailable.");
  const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    project_id: string;
  };
  _gcsClient = new Storage({ projectId: creds.project_id, credentials: creds });
  return _gcsClient;
}

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

export function makeGcsPath(objectName: string): string {
  return `gcs://${getBucketId()}/${objectName}`;
}

export function isGcsPath(filepath: string): boolean {
  return filepath.startsWith("gcs://");
}

function parseGcsPath(gcsPath: string): { bucketId: string; objectName: string } {
  const withoutProtocol = gcsPath.slice("gcs://".length);
  const slashIdx = withoutProtocol.indexOf("/");
  const bucketId = withoutProtocol.slice(0, slashIdx);
  const objectName = withoutProtocol.slice(slashIdx + 1);
  return { bucketId, objectName };
}

// 📝 NOTE: resumable:false is intentional — avoids the multipart resumable
// upload protocol for files that fit in a single request (all uploads here
// are bounded by the 50MB multer limit).
export async function uploadToGcs(
  buffer: Buffer,
  objectName: string,
  contentType: string
): Promise<string> {
  const bucketId = getBucketId();
  const bucket = getGcsClient().bucket(bucketId);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType, resumable: false });
  return makeGcsPath(objectName);
}

export async function downloadFromGcs(gcsPath: string): Promise<Buffer> {
  const { bucketId, objectName } = parseGcsPath(gcsPath);
  const bucket = getGcsClient().bucket(bucketId);
  const file = bucket.file(objectName);
  const [contents] = await file.download();
  return contents;
}

// ⚠️ WARNING: streamFromGcs pipes directly to the Express Response. If the GCS
// stream errors AFTER headers have already been sent (Content-Type,
// Cache-Control), Express cannot send a proper error response — the client sees
// a truncated PDF. The `stream.on("error", reject)` bubbles to the calling
// route handler's catch block, but by then res.headersSent is true.
// For PDF viewer use (small PDFs) this is acceptable. For large production
// downloads consider buffering or using signed GCS URLs instead.
export async function streamFromGcs(
  gcsPath: string,
  res: Response,
  contentType: string
): Promise<void> {
  const { bucketId, objectName } = parseGcsPath(gcsPath);
  const bucket = getGcsClient().bucket(bucketId);
  const file = bucket.file(objectName);
  res.set("Content-Type", contentType);
  res.set("Cache-Control", "private, max-age=300");
  return new Promise((resolve, reject) => {
    const stream = file.createReadStream();
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}
```

---

### `artifacts/api-server/src/app.ts`

```typescript
import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import helmet from "helmet";
import connectPgSimple from "connect-pg-simple";
import path from "path";
import { fileURLToPath } from "url";

import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const app: Express = express();

const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET;
const databaseUrl = process.env.DATABASE_URL;

// ── Required environment variables ──────────────────────────────────────────

if (!sessionSecret) {
  logger.error(
    "SESSION_SECRET environment variable is not set — refusing to start",
  );
  process.exit(1);
}

if (!databaseUrl) {
  logger.error(
    "DATABASE_URL environment variable is not set — refusing to start",
  );
  process.exit(1);
}

// 📝 NOTE: trust proxy 1 tells Express to trust the first hop in X-Forwarded-*
// headers. Required for DigitalOcean's load balancer so that req.protocol
// reflects HTTPS (needed for secure cookies and appUrl.ts).
app.set("trust proxy", 1);

// ── Request logging ──────────────────────────────────────────────────────────

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],  // strip query string from logs
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── Security headers ─────────────────────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          // 🔐 SECURITY: 'unsafe-eval' is required for PDF.js (pdfjs-dist uses
          // eval internally for its worker). This weakens CSP significantly and
          // could allow XSS escalation if an attacker injects content. A future
          // improvement would be to use a hash or nonce instead, or a version
          // of pdfjs that doesn't require eval.
          "'unsafe-eval'",
          "blob:",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        workerSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// ── CORS configuration ───────────────────────────────────────────────────────
//
// APP_ORIGIN can contain one or more comma-separated origins:
// APP_ORIGIN=https://your-app.ondigitalocean.app
// APP_ORIGIN=https://app.example.org,https://admin.example.org

const configuredOrigins = process.env.APP_ORIGIN
  ? process.env.APP_ORIGIN
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  : [];

const developmentOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8080",
  "http://localhost:80",
];

const allowedOrigins = isProduction
  ? configuredOrigins
  : [...configuredOrigins, ...developmentOrigins];

// 📝 NOTE: In production, APP_ORIGIN is required. The server refuses to start
// with an empty allow-list — no CORS wildcard fallback.
if (isProduction && allowedOrigins.length === 0) {
  logger.error(
    "APP_ORIGIN environment variable is not set in production — refusing to start",
  );
  process.exit(1);
}

app.use(
  cors({
    credentials: true,

    origin(origin, callback) {
      // Requests without an Origin header (server-to-server, health checks,
      // curl) are always allowed.
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");

      if (allowedOrigins.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      logger.warn(
        { origin: normalizedOrigin },
        "Blocked request from unauthorized CORS origin",
      );

      callback(
        new Error(`CORS: origin "${normalizedOrigin}" is not allowed`),
      );
    },
  }),
);

// ── Request body limits ──────────────────────────────────────────────────────

// ⚠️ WARNING: 70 MB JSON body limit is very large and applies globally,
// including to all API routes. This is a DoS vector: a malicious client
// can send a 70 MB JSON body to any /api endpoint and consume server memory.
// The signature upload endpoint (which sends base64 image data) is the only
// legitimate consumer of large bodies. Consider scoping this limit to just
// the signing route, or use multer's memory storage for all large uploads.
app.use(
  express.json({
    limit: "70mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "70mb",
  }),
);

// ── PostgreSQL session store ─────────────────────────────────────────────────

const PgStore = connectPgSimple(session);

// 📝 NOTE: Uses the shared @workspace/db pool (already SSL-configured) rather
// than a separate connection string. This ensures session store inherits the
// DATABASE_CA_CERT TLS config.
const sessionStore = new PgStore({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 60 * 60,  // prune expired sessions every hour
});

sessionStore.on("error", (error) => {
  logger.error({ error }, "PostgreSQL session store error");
});

app.use(
  session({
    name: "esign.sid",
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: isProduction,  // required with trust proxy

    cookie: {
      httpOnly: true,
      secure: isProduction,     // HTTPS-only in production
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,  // 24 hours
    },
  }),
);

// ── Health check ─────────────────────────────────────────────────────────────

// 📝 NOTE: /health is mounted BEFORE /api so it is reachable without session
// overhead. Used by DigitalOcean App Platform health checks.
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    environment: process.env.NODE_ENV ?? "development",
    timestamp: new Date().toISOString(),
  });
});

// ── Application routes ───────────────────────────────────────────────────────

app.use("/api", router);

// ── API not-found handler ─────────────────────────────────────────────────────

app.use("/api", (req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} was not found`,
  });
});

// ── Frontend static files ─────────────────────────────────────────────────────
// In production the React build is copied to ./public (one level up from dist/).
// In development this directory won't exist; express.static is a no-op.

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

app.use(express.static(publicDir));

// /sign/* uses sign.html (has noindex meta tag) — separate entry point.
// Everything else falls through to index.html (SPA catch-all).
app.use("/sign", (_req: express.Request, res: express.Response) => {
  res.sendFile(path.join(publicDir, "sign.html"));
});

app.use((_req: express.Request, res: express.Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ── Central error handler ────────────────────────────────────────────────────

// ⚠️ WARNING: The error handler is placed AFTER the SPA fallbacks. Express
// requires the error handler to be the LAST middleware (4-argument signature).
// Currently the SPA fallbacks come before it, which means errors thrown inside
// express.static or sendFile will NOT reach this handler — they propagate to
// Express's default error handler instead. For correctness, the error handler
// should be placed before the SPA catch-all, or the SPA catch-all should
// include try/catch.
app.use(
  (
    error: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error(
      { error, method: req.method, url: req.originalUrl },
      "Unhandled application error",
    );

    res.status(500).json({
      error: "Internal Server Error",
      message: isProduction
        ? "An unexpected error occurred"
        : error.message,
    });
  },
);

export default app;
```

---

## 3. API Server — Routes

### `artifacts/api-server/src/routes/index.ts`

```typescript
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import documentsRouter from "./documents";
import recipientsRouter from "./recipients";
import signingRouter from "./signing";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(documentsRouter);
router.use(recipientsRouter);
router.use(signingRouter);
router.use(adminRouter);

export default router;
```

---

### `artifacts/api-server/src/routes/auth.ts`

```typescript
import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { RegisterBody, LoginBody } from "@workspace/api-zod";
import type { Request, Response } from "express";
import { authRateLimit } from "../lib/rateLimiters.js";

const router: IRouter = Router();

const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_REDIRECT_URI = process.env.AZURE_REDIRECT_URI;

declare module "express-session" {
  interface SessionData {
    userId: string;
    userName: string;
    userEmail: string;
    userRole: string;
    hasSavedSignature: boolean;
    emailVerified: boolean;
    oauthState?: string;
  }
}

function azureConfigured(): boolean {
  return !!(AZURE_TENANT_ID && AZURE_CLIENT_ID && AZURE_CLIENT_SECRET);
}

function getAzureRedirectUri(req: Request): string {
  return AZURE_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/auth/azure/callback`;
}

// 🔐 SECURITY: parseJwt does NOT verify the JWT signature. This is acceptable
// here because the token was received directly from Azure's token endpoint over
// HTTPS (not from the client), so it is implicitly trusted. Do NOT use this
// function for tokens provided by the browser/client.
function parseJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
}

// POST /auth/register
router.post("/auth/register", authRateLimit, async (req: Request, res: Response) => {
  try {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "All fields are required and password must be at least 6 characters" });
      return;
    }
    const { name, password } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      res.status(400).json({ error: "Email already registered" });
      return;
    }

    // 📝 NOTE: First user to register becomes admin. This bootstraps the system
    // without requiring a seed script. Subsequent users are always "user" role
    // and must be promoted by an admin via /admin/users/:id/role.
    const firstUser = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    const role = firstUser.length === 0 ? "admin" : "user";

    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await db.insert(usersTable).values({ id, name, email, password: hashed, role, provider: "local", emailVerified: false });

    req.session.userId = id;
    req.session.userName = name;
    req.session.userEmail = email;
    req.session.userRole = role;
    req.session.hasSavedSignature = false;
    req.session.emailVerified = false;

    res.json({ success: true, user: { id, name, email, role, hasSavedSignature: false } });
  } catch (err) {
    req.log.error({ err }, "register error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/login
router.post("/auth/login", authRateLimit, async (req: Request, res: Response) => {
  try {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    const { email, password } = parsed.data;

    // ⚠️ WARNING: email is not lowercased before the DB query here, but the
    // DB unique index is on lower(email). A user who registered as
    // "User@Example.COM" and logs in as "user@example.com" will get a DB hit
    // (the index ensures uniqueness case-insensitively) but the Drizzle eq()
    // filter is case-sensitive. In practice registration always normalizes to
    // lowercase, but this is fragile if emails are ever inserted differently.
    const users = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (users.length === 0) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const user = users[0];

    if (user.provider !== "local") {
      res.status(401).json({ error: "This account uses Microsoft sign-in. Please use the 'Sign in with Microsoft' button." });
      return;
    }

    if (!user.password) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;
    req.session.userRole = user.role;
    req.session.hasSavedSignature = !!user.signatureData;
    req.session.emailVerified = user.emailVerified ?? false;

    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, hasSavedSignature: !!user.signatureData } });
  } catch (err) {
    req.log.error({ err }, "login error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/logout
router.post("/auth/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// GET /auth/me
router.get("/auth/me", (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  if (!req.session.userId) {
    res.json({ user: null });
    return;
  }
  res.json({
    user: {
      id: req.session.userId,
      name: req.session.userName,
      email: req.session.userEmail,
      role: req.session.userRole ?? "user",
      hasSavedSignature: !!req.session.hasSavedSignature,
    },
  });
});

// GET /auth/me/signature
router.get("/auth/me/signature", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const users = await db.select({ signatureData: usersTable.signatureData }).from(usersTable).where(eq(usersTable.id, req.session.userId)).limit(1);
    res.json({ signatureData: users[0]?.signatureData ?? null });
  } catch (err) {
    req.log.error({ err }, "get signature error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /auth/me/signature
router.put("/auth/me/signature", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const { signatureData } = req.body as { signatureData?: string };
  if (!signatureData) {
    res.status(400).json({ error: "signatureData is required" });
    return;
  }
  // ⚠️ WARNING: signatureData is stored as a raw string (base64 PNG data URL)
  // with no size limit enforced here. The global 70MB JSON body limit is the
  // only guard. Consider adding an explicit size check (e.g., max 200KB for a
  // signature image) to prevent large payloads being stored in the users table.
  try {
    await db.update(usersTable).set({ signatureData }).where(eq(usersTable.id, req.session.userId));
    req.session.hasSavedSignature = true;
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "save signature error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/azure-enabled
router.get("/auth/azure-enabled", (_req: Request, res: Response) => {
  res.json({ enabled: azureConfigured() });
});

// GET /auth/azure  (initiate OAuth2 flow)
router.get("/auth/azure", authRateLimit, (req: Request, res: Response) => {
  if (!azureConfigured()) {
    res.status(503).json({ error: "Azure SSO is not configured" });
    return;
  }
  const state = uuidv4();
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: AZURE_CLIENT_ID!,
    response_type: "code",
    redirect_uri: getAzureRedirectUri(req),
    scope: "openid profile email",
    state,
    response_mode: "query",
  });
  res.redirect(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/authorize?${params}`);
});

// GET /auth/azure/callback
router.get("/auth/azure/callback", async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.redirect(`/auth?error=${encodeURIComponent(error)}`);
    return;
  }

  // 🔐 SECURITY: CSRF state validation — the state parameter must match what
  // was stored in the session when the OAuth flow was initiated. This prevents
  // an attacker from redirecting a victim's browser to complete a forged OAuth
  // callback.
  if (!state || state !== req.session.oauthState) {
    res.redirect("/auth?error=invalid_state");
    return;
  }
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: AZURE_CLIENT_ID!,
          client_secret: AZURE_CLIENT_SECRET!,
          code,
          redirect_uri: getAzureRedirectUri(req),
          grant_type: "authorization_code",
        }),
      }
    );

    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    if (tokens.error) {
      throw new Error((tokens.error_description as string) || (tokens.error as string));
    }

    const idToken = parseJwt(tokens.id_token as string);
    const azureId = idToken.oid as string;
    const rawEmail = ((idToken.email ?? idToken.preferred_username) as string) ?? "";
    const email = rawEmail.toLowerCase();
    const name = (idToken.name as string) || email;

    // 🔐 SECURITY: Lookup is by azureId (oid claim) only, never by email.
    // This prevents "pre-account takeover": an attacker creating a local account
    // with someone else's email cannot hijack the Azure SSO identity.
    let users = await db.select().from(usersTable).where(eq(usersTable.azureId, azureId)).limit(1);

    if (users.length === 0) {
      // Refuse to create Azure account if another local account owns this email.
      // Merging identities without verified proof of prior ownership is unsafe.
      const byEmail = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (byEmail.length > 0) {
        res.redirect("/auth?error=account_conflict");
        return;
      }
      const firstUser = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
      const role = firstUser.length === 0 ? "admin" : "user";
      const id = uuidv4();
      await db.insert(usersTable).values({ id, name, email, role, provider: "azure", azureId });
      users = [{ id, name, email, role, provider: "azure", azureId, password: null, signatureData: null, emailVerified: true, createdAt: new Date() }];
    }

    const user = users[0];
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;
    req.session.userRole = user.role;
    req.session.hasSavedSignature = !!user.signatureData;
    req.session.emailVerified = true;  // Azure-authenticated users are always verified

    res.redirect("/");
  } catch (err) {
    req.log.error({ err }, "azure callback error");
    res.redirect("/auth?error=azure_failed");
  }
});

export default router;
```

---

### `artifacts/api-server/src/routes/emailService.ts`

```typescript
import nodemailer from "nodemailer";
import { logger } from "../lib/logger.js";

// ⚠️ WARNING: The nodemailer transporter is created eagerly at module load time,
// always pointing at smtp.gmail.com (or SMTP_HOST) with whatever credentials
// are set. This means:
//   1. Even when SMTP_USER/SMTP_PASS are not configured, nodemailer initialises
//      an SMTP connection pool targeting the host. In most cases this is harmless
//      (the pool is lazy), but it's fragile — if DNS resolution fails at startup
//      it could block or throw.
//   2. The hardcoded smtp.gmail.com default may cause confusion if operators
//      set SMTP_HOST to a different provider but forget to remove the fallback.
// Consider wrapping transporter creation in smtpConfigured() to make it
// completely inert when not configured.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
});

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

// 📝 NOTE: All three email functions silently skip (warn + return) if SMTP is
// not configured. This means the application works fully without SMTP — signing
// links must be copied manually from the document detail page.

export async function sendSigningEmail(
  recipient: { teamName: string; email: string },
  doc: { title: string },
  signUrl: string,
  subject?: string | null,
  message?: string | null,
  senderName?: string | null
): Promise<void> {
  if (!smtpConfigured()) {
    logger.warn({ recipientEmail: recipient.email, signUrl }, "SMTP not configured — skipping email send");
    return;
  }

  // 🔐 SECURITY: signUrl is embedded directly in the HTML email body without
  // escaping. If signUrl ever contained attacker-controlled content (e.g., from
  // a malformed document title or base URL), this could be an XSS vector for
  // email clients that render HTML. In practice signUrl is constructed from
  // getAppBaseUrl() + "/sign/" + recipient.token (a UUID), so the risk is low.
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
    <div style="background:#f8f9fa;border-radius:8px;padding:30px;margin-bottom:20px">
      <h2 style="color:#1a1a2e;margin-top:0">Document Signature Required</h2>
      <p style="color:#555;line-height:1.6">${message || "Please review and sign the document below."}</p>
      <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#888">Document</p>
        <p style="margin:4px 0 0;font-weight:bold;font-size:16px">${doc.title}</p>
      </div>
      <a href="${signUrl}" style="display:inline-block;background:#1a1a2e;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:10px">Review &amp; Sign Document &rarr;</a>
    </div>
    <p style="font-size:12px;color:#999;text-align:center">Sent by ${senderName || "E-Sign Workflow"}<br>This link is unique to you — do not share it.</p>
    </body></html>`;

  await transporter.sendMail({
    from: `"E-Sign Workflow" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: subject || `Action Required: Please sign "${doc.title}"`,
    html,
  });
}

export async function sendReviewInviteEmail(
  recipient: { teamName: string; email: string },
  doc: { title: string },
  reviewUrl: string,
  senderName?: string | null
): Promise<void> {
  if (!smtpConfigured()) {
    logger.warn({ recipientEmail: recipient.email, reviewUrl }, "SMTP not configured — skipping review invite email");
    return;
  }

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
    <div style="background:#f8f9fa;border-radius:8px;padding:30px;margin-bottom:20px">
      <div style="display:inline-block;background:#1e3a5f;color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:bold;margin-bottom:16px;letter-spacing:0.05em">REVIEW REQUEST</div>
      <h2 style="color:#1a1a2e;margin-top:0">Document Review Required</h2>
      <p style="color:#555;line-height:1.6">You have been asked to review the following document before it is sent for signatures. Please examine it carefully and either approve it or request changes.</p>
      <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#888">Document</p>
        <p style="margin:4px 0 0;font-weight:bold;font-size:16px">${doc.title}</p>
      </div>
      <a href="${reviewUrl}" style="display:inline-block;background:#1e3a5f;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:10px">Review Document &rarr;</a>
    </div>
    <p style="font-size:12px;color:#999;text-align:center">Sent by ${senderName || "E-Sign Workflow"}<br>This link is unique to you — do not share it.</p>
    </body></html>`;

  await transporter.sendMail({
    from: `"E-Sign Workflow" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: `Review Required: "${doc.title}"`,
    html,
  });
}

export async function sendSignUnlockEmail(
  recipient: { teamName: string; email: string },
  doc: { title: string },
  signUrl: string,
  approvedByNames: string[]
): Promise<void> {
  if (!smtpConfigured()) {
    logger.warn({ recipientEmail: recipient.email, signUrl }, "SMTP not configured — skipping sign-unlock email");
    return;
  }

  const approvedByText = approvedByNames.length > 0
    ? `<p style="color:#555;line-height:1.6">This document has been reviewed and approved by: <strong>${approvedByNames.join(", ")}</strong>. It is now ready for your signature.</p>`
    : `<p style="color:#555;line-height:1.6">This document has been reviewed and approved. It is now ready for your signature.</p>`;

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
    <div style="background:#f8f9fa;border-radius:8px;padding:30px;margin-bottom:20px">
      <div style="display:inline-block;background:#166534;color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:bold;margin-bottom:16px;letter-spacing:0.05em">&#10003; REVIEW APPROVED</div>
      <h2 style="color:#1a1a2e;margin-top:0">Ready to Sign</h2>
      ${approvedByText}
      <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#888">Document</p>
        <p style="margin:4px 0 0;font-weight:bold;font-size:16px">${doc.title}</p>
      </div>
      <a href="${signUrl}" style="display:inline-block;background:#166534;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:10px">Sign Document &rarr;</a>
    </div>
    <p style="font-size:12px;color:#999;text-align:center">This link is unique to you — do not share it.</p>
    </body></html>`;

  await transporter.sendMail({
    from: `"E-Sign Workflow" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: `Signature Required: "${doc.title}" has been approved`,
    html,
  });
}
```

---

### `artifacts/api-server/src/routes/documents.ts`

```typescript
import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import { eq, and } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable } from "@workspace/db";
import type { Request, Response } from "express";
import { buildSignedPdf, SignerRecord, ReviewerRecord, DocMeta } from "./pdfSigner.js";
import { uploadToGcs, downloadFromGcs, streamFromGcs, isGcsPath } from "../lib/gcsStorage.js";

const router: IRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    req.resume();  // drain the request body to prevent socket hang
    res.status(401).json({ error: "Please log in first" });
    return;
  }
  next();
}

async function getFileBuffer(filepath: string): Promise<Buffer> {
  if (isGcsPath(filepath)) {
    return downloadFromGcs(filepath);
  }
  return fs.promises.readFile(filepath);
}

async function fileExists(filepath: string): Promise<boolean> {
  if (isGcsPath(filepath)) return true;  // assume GCS files exist; no HEAD request
  return fs.existsSync(filepath);
}

// GET /documents
router.get("/documents", requireAuth, async (req: Request, res: Response) => {
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.uploadedBy, req.session.userId!));

    // ⚠️ WARNING: N+1 query problem. For each document, a separate SELECT is
    // issued to recipientsTable. With many documents, this generates O(N) DB
    // round-trips. Fix: use a single JOIN with GROUP BY, or a single
    // IN query on documentIds, then aggregate in application code.
    const result = await Promise.all(
      docs.map(async (doc) => {
        const recs = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, doc.id));
        return {
          ...doc,
          totalRecipients: recs.length,
          signedCount: recs.filter((r) => r.status === "signed").length,
        };
      })
    );

    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ documents: result });
  } catch (err) {
    req.log.error({ err }, "list documents error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Multer: memoryStorage, 50MB limit, PDF only
const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    // 📝 NOTE: Only PDF is accepted. The replit.md mentions DOCX auto-conversion
    // via LibreOffice as a feature, but that code was removed. If re-adding DOCX
    // support, update fileFilter here and add LibreOffice conversion after upload.
    if (ext === ".pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// POST /documents
router.post("/documents", requireAuth, multerUpload.single("file"), async (req: Request, res: Response) => {
  try {
    const uploadedFile = req.file;
    const { title, signing_order } = req.body as { title?: string; signing_order?: string };

    if (!uploadedFile) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const fileName = uploadedFile.originalname;
    const pdfBuffer: Buffer = uploadedFile.buffer;

    // Upload directly to GCS from memory buffer (no temp file on disk)
    const objectName = `documents/${uuidv4()}.pdf`;
    const gcsPath = await uploadToGcs(pdfBuffer, objectName, "application/pdf");

    const newId = uuidv4();
    await db.insert(documentsTable).values({
      id: newId,
      title: title || fileName,
      filename: fileName,
      filepath: gcsPath,
      uploadedBy: req.session.userId!,
      uploaderName: req.session.userName!,
      signingOrder: signing_order === "sequential" ? "sequential" : "simultaneous",
      status: "draft",
    });
    res.json({ success: true, documentId: newId });
  } catch (err) {
    req.log.error({ err }, "upload document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /documents/:id
router.get("/documents/:id", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const doc = docs[0];
    const recipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id));
    recipients.sort((a, b) => a.signOrder - b.signOrder);

    const fields = await db.select().from(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));

    res.json({
      document: {
        ...doc,
        totalRecipients: recipients.length,
        signedCount: recipients.filter((r) => r.status === "signed").length,
      },
      recipients,
      fields,
    });
  } catch (err) {
    req.log.error({ err }, "get document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /documents/:id/file  (authenticated PDF serving)
router.get("/documents/:id/file", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const doc = docs[0];
    if (!(await fileExists(doc.filepath))) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    if (isGcsPath(doc.filepath)) {
      await streamFromGcs(doc.filepath, res, "application/pdf");
    } else {
      // Legacy: local filesystem path (pre-migration documents)
      const ext = path.extname(doc.filepath).toLowerCase();
      const contentType = ext === ".pdf" ? "application/pdf" : "application/octet-stream";
      res.set("Content-Type", contentType);
      res.set("Cache-Control", "private, max-age=300");
      res.sendFile(path.resolve(doc.filepath));
    }
  } catch (err) {
    req.log.error({ err }, "serve document file error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /documents/:id/fields
router.get("/documents/:id/fields", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const fields = await db.select().from(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));
    res.json({ fields });
  } catch (err) {
    req.log.error({ err }, "get fields error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /documents/:id/fields
router.put("/documents/:id/fields", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const { fields } = req.body as {
      fields: Array<{ recipientId: string; page: number; x: number; y: number; width: number; height: number; fieldType?: string }>;
    };

    if (!Array.isArray(fields)) {
      res.status(400).json({ error: "fields must be an array" });
      return;
    }

    // ⚠️ WARNING: Field coordinates (x, y, width, height) from the client are
    // written directly to the DB without bounds validation. An attacker could
    // submit fields with x=1000 or y=-5 which would then be used in pdfSigner.ts
    // causing fields to be drawn outside page boundaries. Consider validating
    // that all values are in [0, 1] range.
    await db.delete(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));

    if (fields.length > 0) {
      await db.insert(signatureFieldsTable).values(
        fields.map((f) => ({
          id: uuidv4(),
          documentId: id,
          recipientId: f.recipientId,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          fieldType: f.fieldType ?? "signature",
        }))
      );
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "save fields error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /documents/:id/download  (authenticated, on-demand signed PDF)
router.get("/documents/:id/download", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    const doc = docs[0];
    if (!doc || !(await fileExists(doc.filepath))) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // Run DB queries and file load in parallel for speed
    const [recipients, allFields, fileSource] = await Promise.all([
      db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id)),
      db.select().from(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id)),
      isGcsPath(doc.filepath) ? getFileBuffer(doc.filepath) : Promise.resolve(doc.filepath),
    ]);

    const signedRecipients = recipients.filter((r) => r.status === "signed");
    const reviewerRecipients = recipients.filter((r) => r.requiresReview && r.reviewStatus);

    const entries = signedRecipients.flatMap((r) => {
      const recipientFields = allFields.filter((f) => f.recipientId === r.id);
      // 📝 NOTE: Use actual signedAt, never fall back to current time.
      // Falling back would show wrong timestamps on the signed PDF.
      const signedAt = r.signedAt ? new Date(r.signedAt) : null;
      if (!signedAt) return [];
      const signerName = r.signerName || r.teamName;
      return recipientFields
        .filter((f) => f.fieldValue)
        .map((f) => ({
          fieldType: (f.fieldType || "signature") as "signature" | "initials" | "date" | "text",
          fieldValue: f.fieldValue!,
          signerName,
          signedAt,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        }));
    });

    const signerRecords: SignerRecord[] = signedRecipients
      .filter((r) => r.signedAt)
      .map((r) => ({
        name: r.signerName || r.teamName,
        email: r.email,
        signedAt: new Date(r.signedAt!),
        ipAddress: r.ipAddress,
      }));

    const reviewerRecords: ReviewerRecord[] = reviewerRecipients
      .filter((r) => r.reviewedAt)
      .map((r) => ({
        name: r.signerName || r.teamName,
        email: r.email,
        reviewedAt: new Date(r.reviewedAt!),
        ipAddress: r.ipAddress,
        decision: (r.reviewStatus === "approved" ? "approved" : "changes_requested") as "approved" | "changes_requested",
        note: r.reviewNote ?? null,
      }));

    // completedAt = latest actual signature time
    const completedAt = signerRecords.reduce<Date>((latest, r) => {
      return r.signedAt > latest ? r.signedAt : latest;
    }, new Date(0));

    const docMeta: DocMeta = {
      documentName: doc.filename,
      documentId: doc.id,
      completedAt: completedAt.getTime() === 0 ? new Date() : completedAt,
    };

    // ⚠️ WARNING: buildSignedPdf() loads the full PDF into memory, embeds images
    // and fonts, and returns the result as a Uint8Array. For large PDFs (tens of
    // MB) this can spike memory significantly. The on-demand generation here is
    // acceptable for a low-traffic internal tool but would not scale to many
    // concurrent downloads. The preferred path (when available) is the pre-sealed
    // PDF at doc.sealedPdfPath.
    const pdfBytes = await buildSignedPdf(fileSource, entries, {
      doc: docMeta,
      signers: signerRecords,
      reviewers: reviewerRecords,
    });
    const safeName = doc.filename.replace(/[^a-z0-9.\-_]/gi, "_");
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${safeName}"`);
    res.set("Content-Length", String(pdfBytes.byteLength));
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    req.log.error({ err }, "download signed pdf error");
    res.status(500).json({ error: "Failed to generate signed PDF" });
  }
});

// DELETE /documents/:id
router.delete("/documents/:id", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const doc = docs[0];
    if (doc.status === "sent" || doc.status === "completed") {
      res.status(409).json({ error: "Documents that have been sent for signing or are completed cannot be deleted." });
      return;
    }

    // 📝 NOTE: GCS file is NOT deleted when the document is deleted from the DB.
    // This leaves orphaned objects in GCS. For a low-volume internal tool this is
    // acceptable. To fully clean up, add a call to getGcsClient().bucket().file().delete()
    // here.
    await db.delete(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));
    await db.delete(recipientsTable).where(eq(recipientsTable.documentId, id));
    await db.delete(documentsTable).where(eq(documentsTable.id, id));

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "delete document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /documents/:id/status
router.get("/documents/:id/status", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const recipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id));
    recipients.sort((a, b) => a.signOrder - b.signOrder);
    res.json({ recipients, status: docs[0].status });
  } catch (err) {
    req.log.error({ err }, "get document status error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
```

---

### `artifacts/api-server/src/routes/recipients.ts`

```typescript
import { Router, type IRouter } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable } from "@workspace/db";
import { SetRecipientsBody } from "@workspace/api-zod";
import type { Request, Response } from "express";
import { sendSigningEmail, sendReviewInviteEmail, sendSignUnlockEmail } from "./emailService.js";
import { getAppBaseUrl } from "../lib/appUrl.js";

const router: IRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Please log in first" });
    return;
  }
  next();
}

// POST /documents/:id/recipients
router.post("/documents/:id/recipients", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const parsed = SetRecipientsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid recipients data" });
      return;
    }

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const existing = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, id));
    existing.sort((a, b) => a.signOrder - b.signOrder);

    const newList = parsed.data.recipients;

    // 📝 NOTE: Recipients are matched by position (index), not by ID or email.
    // This means updating recipients preserves the first N existing records by
    // position, which could cause unexpected behavior if the UI reorders
    // recipients. However since the UI always sends the full list in order,
    // this works in practice.
    for (let i = 0; i < newList.length; i++) {
      const r = newList[i];
      const existingRec = existing[i];
      const requiresReview = r.requiresReview ?? false;
      const requiresSignature = r.requiresSignature ?? true;
      const reviewChecklistInput = r.reviewChecklist;
      const reviewChecklist = reviewChecklistInput
        ? reviewChecklistInput.map((item) => ({ label: item.label, checked: false }))
        : null;

      if (existingRec) {
        await db
          .update(recipientsTable)
          .set({
            teamName: r.teamName,
            email: r.email,
            signOrder: i + 1,
            requiresReview,
            requiresSignature,
            reviewStatus: requiresReview ? (existingRec.reviewStatus ?? "pending") : null,
            reviewChecklist: reviewChecklist as null,
          })
          .where(eq(recipientsTable.id, existingRec.id));
      } else {
        // Token expires 90 days from creation
        const tokenExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        await db.insert(recipientsTable).values({
          id: uuidv4(),
          documentId: id,
          teamName: r.teamName,
          email: r.email,
          signOrder: i + 1,
          status: "pending",
          token: uuidv4(),
          requiresReview,
          requiresSignature,
          reviewStatus: requiresReview ? "pending" : null,
          reviewChecklist: reviewChecklist as null,
          tokenExpiresAt,
        });
      }
    }

    // Remove extra recipients if the new list is shorter
    if (existing.length > newList.length) {
      for (const removed of existing.slice(newList.length)) {
        await db.delete(signatureFieldsTable).where(eq(signatureFieldsTable.recipientId, removed.id));
        await db.delete(recipientsTable).where(eq(recipientsTable.id, removed.id));
      }
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "set recipients error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /documents/:id/send
router.post("/documents/:id/send", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const { subject, message } = req.body as { subject?: string; message?: string };

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const doc = docs[0];
    const allRecipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id));
    allRecipients.sort((a, b) => a.signOrder - b.signOrder);

    if (allRecipients.length === 0) {
      res.status(400).json({ error: "No recipients added" });
      return;
    }

    const baseUrl = getAppBaseUrl(req);

    const reviewers = allRecipients.filter((r) => r.requiresReview);
    const signers = allRecipients.filter((r) => r.requiresSignature && !r.requiresReview);

    let sent = 0;

    if (reviewers.length > 0) {
      // If there are reviewers, send review invites first (signers wait for gate to open)
      const toSendReviewers = doc.signingOrder === "sequential" ? [reviewers[0]] : reviewers;
      for (const r of toSendReviewers) {
        await sendReviewInviteEmail(r, doc, `${baseUrl}/review/${r.token}`, req.session.userName);
        sent++;
      }
      await db.update(documentsTable).set({ status: "in_review" as string }).where(eq(documentsTable.id, id));
    } else {
      const toSend = doc.signingOrder === "sequential" ? [signers[0] ?? allRecipients[0]] : allRecipients;
      for (const r of toSend) {
        await sendSigningEmail(r, doc, `${baseUrl}/sign/${r.token}`, subject, message, req.session.userName);
        sent++;
      }
      await db.update(documentsTable).set({ status: "sent" }).where(eq(documentsTable.id, id));
    }

    res.json({ success: true, sent });
  } catch (err) {
    req.log.error({ err }, "send document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /recipients/:recipientId/remind
router.post("/recipients/:recipientId/remind", requireAuth, async (req: Request, res: Response) => {
  const recipientId = req.params.recipientId as string;
  try {
    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.id, recipientId))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Recipient not found" });
      return;
    }

    const r = recs[0];
    if (r.status === "signed" && (!r.requiresReview || r.reviewStatus === "approved")) {
      res.status(400).json({ error: "Recipient has already completed their action" });
      return;
    }

    // 🔐 SECURITY: Ownership check is on the document, not the recipient directly.
    // The recipient is fetched first (above) without ownership validation.
    // This is fine because the document ownership check is done before any
    // action is taken (email sent). The only timing oracle is that 404 vs 403
    // reveals whether a recipientId exists — acceptable for this use case.
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, r.documentId), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    if (docs.length === 0) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    const doc = docs[0];
    const baseUrl = getAppBaseUrl(req);

    if (r.requiresReview && (r.reviewStatus === null || r.reviewStatus === "pending")) {
      await sendReviewInviteEmail(r, doc, `${baseUrl}/review/${r.token}`, req.session.userName);
    } else if (r.requiresSignature && r.status !== "signed") {
      const allRecipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, r.documentId));
      const reviewers = allRecipients.filter((x) => x.requiresReview);
      const gateOpen = reviewers.every((x) => x.reviewStatus === "approved");
      const approvedNames = reviewers.filter((x) => x.reviewStatus === "approved").map((x) => x.signerName || x.teamName);
      if (!gateOpen) {
        res.status(400).json({ error: "Cannot send signing reminder — reviewers have not approved yet" });
        return;
      }
      await sendSignUnlockEmail(r, doc, `${baseUrl}/sign/${r.token}`, approvedNames);
    } else {
      await sendSigningEmail(
        r, doc, `${baseUrl}/sign/${r.token}`,
        `Reminder: Please sign "${doc.title}"`,
        "This is a reminder that your signature is required on this document.",
        req.session.userName
      );
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "remind recipient error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /documents/:id/remind-all
router.post("/documents/:id/remind-all", requireAuth, async (req: Request, res: Response) => {
  const documentId = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, documentId), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    if (docs.length === 0) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    const doc = docs[0];
    const baseUrl = getAppBaseUrl(req);

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, documentId));

    const reviewers = allRecipients.filter((x) => x.requiresReview);
    const gateOpen = reviewers.every((x) => x.reviewStatus === "approved");
    const approvedNames = reviewers.filter((x) => x.reviewStatus === "approved").map((x) => x.signerName || x.teamName);

    let sent = 0;
    const errors: string[] = [];

    for (const r of allRecipients) {
      const alreadyDone =
        r.status === "signed" &&
        (!r.requiresReview || r.reviewStatus === "approved" || r.reviewStatus === "changes_requested");
      if (alreadyDone) continue;

      try {
        if (r.requiresReview && (r.reviewStatus === null || r.reviewStatus === "pending")) {
          await sendReviewInviteEmail(r, doc, `${baseUrl}/review/${r.token}`, req.session.userName);
          sent++;
        } else if (r.requiresSignature && r.status !== "signed") {
          if (!gateOpen) continue; // gate not open yet — skip silently
          await sendSignUnlockEmail(r, doc, `${baseUrl}/sign/${r.token}`, approvedNames);
          sent++;
        } else if (!r.requiresReview && !r.requiresSignature) {
          continue;
        } else {
          await sendSigningEmail(
            r, doc, `${baseUrl}/sign/${r.token}`,
            `Reminder: Please sign "${doc.title}"`,
            "This is a reminder that your signature is required on this document.",
            req.session.userName
          );
          sent++;
        }
      } catch (e) {
        errors.push(r.email);
        req.log.warn({ err: e, recipientId: r.id }, "remind-all: failed to send to one recipient");
      }
    }

    res.json({ success: true, sent, errors });
  } catch (err) {
    req.log.error({ err }, "remind-all error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
```

---

### `artifacts/api-server/src/routes/signing.ts`

```typescript
import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable, documentEventsTable } from "@workspace/db";
import fs from "fs";
import path from "path";
import { SubmitSignatureBody } from "@workspace/api-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { Request, Response } from "express";
import { sendSigningEmail, sendReviewInviteEmail, sendSignUnlockEmail } from "./emailService.js";
import { getAppBaseUrl } from "../lib/appUrl.js";
import { buildSignedPdf, SignerRecord, DocMeta, ReviewerRecord } from "./pdfSigner.js";
import { downloadFromGcs, streamFromGcs, isGcsPath, uploadToGcs } from "../lib/gcsStorage.js";
import { createHash } from "crypto";
import { signingRateLimit } from "../lib/rateLimiters.js";

const router: IRouter = Router();

const SubmitReviewBody = z.object({
  decision: z.enum(["approve", "request_changes"]),
  checklist: z.array(z.object({ label: z.string(), checked: z.boolean() })).nullish(),
  note: z.string().max(2000).nullish(),
});

async function fileExists(filepath: string): Promise<boolean> {
  if (isGcsPath(filepath)) return true;
  return fs.existsSync(filepath);
}

async function getFileBuffer(filepath: string): Promise<Buffer> {
  if (isGcsPath(filepath)) {
    return downloadFromGcs(filepath);
  }
  return fs.promises.readFile(filepath);
}

async function insertEvent(data: {
  documentId: string;
  recipientId?: string;
  eventType: string;
  actorName?: string | null;
  actorEmail?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  await db.insert(documentEventsTable).values({
    id: uuidv4(),
    documentId: data.documentId,
    recipientId: data.recipientId ?? null,
    eventType: data.eventType,
    actorName: data.actorName ?? null,
    actorEmail: data.actorEmail ?? null,
    metadata: (data.metadata ?? null) as null,
    ipAddress: data.ipAddress ?? null,
    userAgent: data.userAgent ?? null,
    createdAt: new Date(),
  });
}

type RecipientRow = typeof recipientsTable.$inferSelect;

// computeNextStep determines what action a recipient should take next.
// Returns: "review" | "sign" | "done" | "blocked"
function computeNextStep(
  recipient: RecipientRow,
  allRecipients: RecipientRow[],
  signingOrder: string
): "review" | "sign" | "done" | "blocked" {
  const reviewers = allRecipients.filter((r) => r.requiresReview);
  const gateOpen = reviewers.every((r) => r.reviewStatus === "approved");

  const priorSignerPending = (rec: RecipientRow): boolean =>
    signingOrder === "sequential" &&
    allRecipients.some(
      (r) =>
        r.requiresSignature &&
        r.signOrder < rec.signOrder &&
        r.status !== "signed"
    );

  if (recipient.requiresReview) {
    if (
      recipient.reviewStatus === null ||
      recipient.reviewStatus === "pending" ||
      recipient.reviewStatus === undefined
    ) {
      return "review";
    }
    if (recipient.requiresSignature && recipient.status !== "signed") {
      if (!gateOpen) return "blocked";
      if (priorSignerPending(recipient)) return "blocked";
      return "sign";
    }
    return "done";
  }

  if (recipient.requiresSignature) {
    if (recipient.status === "signed") return "done";
    if (!gateOpen) return "blocked";
    if (priorSignerPending(recipient)) return "blocked";
    return "sign";
  }

  return "done";
}

// maybeUnlockSigners: called after a reviewer approves.
// If all reviewers have now approved, send signing emails to unlocked signers.
async function maybeUnlockSigners(
  documentId: string,
  baseUrl: string,
  doc: { title: string; filename: string; signingOrder: string },
  triggeredByName: string | null
) {
  const allRecipients = await db
    .select()
    .from(recipientsTable)
    .where(eq(recipientsTable.documentId, documentId));

  const reviewers = allRecipients.filter((r) => r.requiresReview);
  if (!reviewers.every((r) => r.reviewStatus === "approved")) return;

  const approvedReviewerNames = reviewers
    .map((r) => r.signerName || r.teamName)
    .filter(Boolean);

  const pendingSigners = allRecipients.filter(
    (r) => r.requiresSignature && r.status !== "signed" && !r.requiresReview
  );

  const toSend =
    doc.signingOrder === "sequential"
      ? pendingSigners.slice(0, 1)
      : pendingSigners;

  for (const signer of toSend) {
    await sendSignUnlockEmail(
      signer,
      doc,
      `${baseUrl}/sign/${signer.token}`,
      approvedReviewerNames
    );
  }

  const docStatus = doc.signingOrder === "simultaneous" && pendingSigners.length === 0
    ? "completed"
    : "sent";

  // 🐛 BUG: The document status update only runs when:
  //   reviewers.length > 0 AND pendingSigners.length > 0
  // But if all reviewers approve and there are NO signers (review-only workflow),
  // pendingSigners.length === 0 and the status update is skipped, leaving the
  // document in "in_review" status indefinitely. For review-only workflows with
  // no signers, the document should transition to "completed" here.
  if (reviewers.length > 0 && pendingSigners.length > 0) {
    await db
      .update(documentsTable)
      .set({ status: docStatus })
      .where(eq(documentsTable.id, documentId));
  }
}

// GET /signing/my-requests
router.get("/signing/my-requests", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!req.session.emailVerified) {
    res.json({ requests: [] });
    return;
  }
  try {
    const email = (req.session.userEmail ?? "").toLowerCase();

    // ⚠️ WARNING: Matches recipients by email address (session.userEmail).
    // If a recipient was added with a different case email than the user's
    // registered email, they won't see their pending signing requests here.
    // This is purely a dashboard convenience feature; signing itself uses tokens.
    const recipients = await db
      .select({
        id: recipientsTable.id,
        documentId: recipientsTable.documentId,
        status: recipientsTable.status,
        signedAt: recipientsTable.signedAt,
        teamName: recipientsTable.teamName,
      })
      .from(recipientsTable)
      .where(eq(recipientsTable.email, email));

    if (recipients.length === 0) {
      res.json({ requests: [] });
      return;
    }

    const documentIds = [...new Set(recipients.map((r) => r.documentId))];
    const documents = await db
      .select({
        id: documentsTable.id,
        title: documentsTable.title,
        uploaderName: documentsTable.uploaderName,
        status: documentsTable.status,
        createdAt: documentsTable.createdAt,
      })
      .from(documentsTable)
      .where(inArray(documentsTable.id, documentIds));

    const docMap = new Map(documents.map((d) => [d.id, d]));

    const requests = recipients
      .map((r) => {
        const doc = docMap.get(r.documentId);
        return {
          recipientId: r.id,
          documentId: r.documentId,
          documentTitle: doc?.title ?? "Unknown Document",
          senderName: doc?.uploaderName ?? "Unknown",
          recipientStatus: r.status,
          signedAt: r.signedAt?.toISOString() ?? null,
          sentAt: doc?.createdAt.toISOString() ?? null,
        };
      })
      .sort((a, b) => {
        const aIsPending = a.recipientStatus !== "signed";
        const bIsPending = b.recipientStatus !== "signed";
        if (aIsPending && !bIsPending) return -1;
        if (!aIsPending && bIsPending) return 1;
        return new Date(b.sentAt ?? 0).getTime() - new Date(a.sentAt ?? 0).getTime();
      });

    res.json({ requests });
  } catch (err) {
    req.log.error({ err }, "my signing requests error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /sign/:token  (public — fetch signing info)
router.get("/sign/:token", signingRateLimit, async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.token, token))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid or expired signing link" });
      return;
    }

    const r = recs[0];
    if (r.tokenExpiresAt && r.tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
      return;
    }

    const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
    const doc = docs[0];

    // Mark as "viewed" on first access (only for signing recipients, not reviewers)
    if (r.status !== "signed" && !r.requiresReview) {
      await db
        .update(recipientsTable)
        .set({ status: "viewed", viewedAt: new Date() })
        .where(eq(recipientsTable.token, token));
    }

    const fields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.recipientId, r.id));

    let allSignedFields: typeof fields = [];
    if (doc?.status === "completed") {
      // On completion, return all fields (all signers) for the completion overlay
      allSignedFields = await db
        .select()
        .from(signatureFieldsTable)
        .where(eq(signatureFieldsTable.documentId, r.documentId));
    }

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const nextStep = computeNextStep(r, allRecipients, doc?.signingOrder ?? "simultaneous");

    const approvedReviewers = allRecipients
      .filter((x) => x.requiresReview && x.reviewStatus === "approved")
      .map((x) => ({
        name: x.signerName || x.teamName,
        teamName: x.teamName,
        reviewedAt: x.reviewedAt?.toISOString() ?? new Date().toISOString(),
        note: x.reviewNote ?? null,
      }));

    const rejectedReviewers = allRecipients
      .filter((x) => x.requiresReview && x.reviewStatus === "changes_requested")
      .map((x) => ({
        name: x.signerName || x.teamName,
        teamName: x.teamName,
        reviewedAt: x.reviewedAt?.toISOString() ?? null,
        note: x.reviewNote ?? null,
      }));

    res.json({
      recipient: r,
      documentTitle: doc?.title ?? "Unknown Document",
      documentFilename: doc?.filename ?? "",
      alreadySigned: r.status === "signed",
      documentStatus: doc?.status ?? "sent",
      fields,
      allSignedFields,
      nextStep,
      approvedReviewers,
      reviewRejected: rejectedReviewers.length > 0,
      rejectedReviewers,
    });
  } catch (err) {
    req.log.error({ err }, "get signing info error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /sign/:token/review  (public — submit review decision)
router.post("/sign/:token/review", signingRateLimit, async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const parsed = SubmitReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid review submission" });
      return;
    }

    const { decision, checklist, note } = parsed.data;

    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.token, token))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid review link" });
      return;
    }

    const r = recs[0];

    if (r.tokenExpiresAt && r.tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
      return;
    }

    if (!r.requiresReview) {
      res.status(400).json({ error: "This link is not a review link" });
      return;
    }

    // 📝 NOTE: Reviewers can change their decision (approve ↔ request_changes).
    // There is no lock after submitting — the UI shows a "Change my decision"
    // button. The audit trail records the final state only.

    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
    const ua = req.headers["user-agent"] ?? null;
    const reviewStatus = decision === "approve" ? "approved" : "changes_requested";

    await db
      .update(recipientsTable)
      .set({
        reviewStatus,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
        reviewChecklist: checklist ?? null,
        status: "viewed",
        viewedAt: new Date(),
        signerName: r.teamName,
        ipAddress: ip,
      })
      .where(eq(recipientsTable.token, token));

    const eventType = decision === "approve" ? "review_approved" : "review_changes_requested";
    await insertEvent({
      documentId: r.documentId,
      recipientId: r.id,
      eventType,
      actorName: r.teamName,
      actorEmail: r.email,
      metadata: { decision, note: note ?? null, checklist: checklist ?? null },
      ipAddress: ip,
      userAgent: ua,
    });

    const reviewDocs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
    const reviewDoc = reviewDocs[0];

    if (decision === "approve" && reviewDoc) {
      const baseUrl = getAppBaseUrl(req);
      await maybeUnlockSigners(r.documentId, baseUrl, reviewDoc, r.teamName);
    }

    // Re-fetch all recipients after the update to compute accurate nextStep
    const allRecipientsAfter = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const updatedRecipient = allRecipientsAfter.find((x) => x.token === token)!;
    const nextStep = computeNextStep(updatedRecipient, allRecipientsAfter, reviewDoc?.signingOrder ?? "simultaneous");

    res.json({ success: true, nextStep, requiresSignature: r.requiresSignature });
  } catch (err) {
    req.log.error({ err }, "submit review error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /sign/:token  (public — submit signature)
router.post("/sign/:token", signingRateLimit, async (req: Request, res: Response) => {
  const token = req.params.token as string;
  try {
    const parsed = SubmitSignatureBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Full name and signature are required" });
      return;
    }

    const { fullName, signatureData, fieldValues } = parsed.data;

    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.token, token))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid signing link" });
      return;
    }

    const r = recs[0];

    if (r.tokenExpiresAt && r.tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
      return;
    }

    if (r.status === "signed") {
      res.status(400).json({ error: "Already signed" });
      return;
    }

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
    const doc = docs[0];

    const nextStep = computeNextStep(r, allRecipients, doc?.signingOrder ?? "simultaneous");
    if (nextStep === "blocked") {
      res.status(409).json({ error: "Signing is not yet available — either awaiting reviewer approval or a prior signer has not yet completed" });
      return;
    }
    if (nextStep === "review") {
      res.status(409).json({ error: "You must complete your review before signing" });
      return;
    }

    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
    const ua = req.headers["user-agent"] ?? null;

    // Mark the recipient as signed
    await db
      .update(recipientsTable)
      .set({
        status: "signed",
        signedAt: new Date(),
        signerName: fullName,
        ipAddress: ip,
        signatureData: signatureData ?? null,
      })
      .where(eq(recipientsTable.token, token));

    await insertEvent({
      documentId: r.documentId,
      recipientId: r.id,
      eventType: "signed",
      actorName: fullName,
      actorEmail: r.email,
      ipAddress: ip,
      userAgent: ua,
    });

    // Save field values for each of this recipient's fields
    const recipientFields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.recipientId, r.id));

    for (const field of recipientFields) {
      let value: string | null = null;
      if (field.fieldType === "signature" || field.fieldType === "initials") {
        value = signatureData ?? null;
      } else if (fieldValues && fieldValues[field.id] !== undefined) {
        value = fieldValues[field.id];
      }
      if (value !== null) {
        await db
          .update(signatureFieldsTable)
          .set({ fieldValue: value })
          .where(eq(signatureFieldsTable.id, field.id));
      }
    }

    // Re-fetch recipients to check completion
    const freshRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const signers = freshRecipients.filter((x) => x.requiresSignature);

    // Notify next sequential signer (if applicable)
    if (doc?.signingOrder === "sequential") {
      freshRecipients.sort((a, b) => a.signOrder - b.signOrder);
      const next = freshRecipients.find(
        (x) => x.requiresSignature && !x.requiresReview && x.signOrder === r.signOrder + 1 && x.status === "pending"
      );
      if (next) {
        const baseUrl = getAppBaseUrl(req);
        await sendSigningEmail(next, doc, `${baseUrl}/sign/${next.token}`, null, null, "E-Sign Workflow");
      }
    }

    // Check if all signers are done
    // 🐛 BUG / ⚠️ RACE CONDITION: The condition below is:
    //   signers.every((x) => x.status === "signed" || x.id === r.id)
    //
    // The `|| x.id === r.id` clause accounts for the fact that freshRecipients
    // was fetched after the DB update, so the current recipient's row SHOULD
    // already show status="signed". In practice this is redundant but harmless
    // for single-concurrent-request scenarios.
    //
    // ACTUAL RACE: If two signers submit simultaneously on a "simultaneous"
    // document, both can fetch freshRecipients where each other appears as
    // "pending" (the other's DB update hasn't committed yet). Both would then
    // satisfy this condition (each treating themselves as "signed" via || x.id === r.id
    // and the other as still "pending", preventing the `every()` from being true)
    // — meaning NEITHER would trigger completion. The document would be stuck
    // in "sent" status with all signers signed. Fix: use a DB-level check
    // (SELECT COUNT WHERE status != 'signed') inside a transaction, or trigger
    // completion asynchronously via a background job/cron.
    if (signers.every((x) => x.status === "signed" || x.id === r.id)) {
      const now = new Date();
      await db
        .update(documentsTable)
        .set({ status: "completed", completedAt: now })
        .where(eq(documentsTable.id, r.documentId));

      await insertEvent({
        documentId: r.documentId,
        eventType: "completed",
        actorName: "System",
        actorEmail: null,
      });

      if (doc) {
        try {
          const allFields = await db
            .select()
            .from(signatureFieldsTable)
            .where(eq(signatureFieldsTable.documentId, r.documentId));

          const reviewerRecords: ReviewerRecord[] = freshRecipients
            .filter((x) => x.requiresReview && x.reviewStatus === "approved")
            .map((x) => ({
              name: x.signerName || x.teamName,
              email: x.email,
              reviewedAt: x.reviewedAt ?? now,
              ipAddress: x.ipAddress,
              decision: "approved" as const,
              note: x.reviewNote,
            }));

          // 📝 NOTE: signedRecipients uses the same `|| x.id === r.id` pattern
          // to ensure the current signer is included even if freshRecipients
          // was fetched before the DB update committed (defensive coding).
          const signedRecipients = freshRecipients.filter((x) => x.status === "signed" || x.id === r.id);
          const entries = signedRecipients.flatMap((sr) => {
            const rFields = allFields.filter((f) => f.recipientId === sr.id);
            const signedAt = sr.signedAt ? new Date(sr.signedAt) : now;
            const name = (sr.id === r.id ? fullName : sr.signerName) || sr.teamName;
            return rFields.filter((f) => f.fieldValue).map((f) => ({
              fieldType: (f.fieldType || "signature") as "signature" | "initials" | "date" | "text",
              fieldValue: f.fieldValue!,
              signerName: name,
              signedAt,
              page: f.page,
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
            }));
          });

          const signerRecords: SignerRecord[] = signedRecipients.map((sr) => ({
            name: (sr.id === r.id ? fullName : sr.signerName) || sr.teamName,
            email: sr.email,
            signedAt: sr.signedAt ? new Date(sr.signedAt) : now,
            ipAddress: sr.ipAddress,
          }));

          const docMeta: DocMeta = { documentName: doc.filename, documentId: doc.id, completedAt: now };
          const source = isGcsPath(doc.filepath) ? await getFileBuffer(doc.filepath) : doc.filepath;
          const sealedBytes = await buildSignedPdf(source, entries, { doc: docMeta, signers: signerRecords, reviewers: reviewerRecords });
          const sealedBuf = Buffer.from(sealedBytes);
          const sealedHash = createHash("sha256").update(sealedBuf).digest("hex");

          const gcsPath = await uploadToGcs(sealedBuf, `sealed/${doc.id}.pdf`, "application/pdf");
          await db.update(documentsTable).set({ sealedPdfPath: gcsPath, sealedPdfHash: sealedHash }).where(eq(documentsTable.id, r.documentId));

          await insertEvent({
            documentId: r.documentId,
            eventType: "sealed",
            actorName: "System",
            actorEmail: null,
            metadata: { sealedHash, gcsPath },
          });
        } catch (sealErr) {
          // 📝 NOTE: PDF sealing is non-fatal. If GCS upload fails, the document
          // is still marked "completed" in the DB. The download endpoint will
          // fall back to on-demand PDF generation.
          req.log.error({ sealErr }, "non-fatal: failed to seal PDF after completion");
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "submit signature error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /sign/:token/download  (public — download signed PDF)
router.get("/sign/:token/download", signingRateLimit, async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const recs = await db.select().from(recipientsTable).where(eq(recipientsTable.token, token)).limit(1);
    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid signing link" });
      return;
    }
    if (recs[0].tokenExpiresAt && recs[0].tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
      return;
    }
    const docId = recs[0].documentId;
    const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, docId)).limit(1);
    const doc = docs[0];
    if (!doc || !(await fileExists(doc.filepath))) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const allRecipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, docId));
    const signedRecipients = allRecipients.filter((r) => r.status === "signed");
    const signers = allRecipients.filter((r) => r.requiresSignature);

    // Prevent download before all signers have signed
    if (signedRecipients.length < signers.length) {
      res.status(403).json({ error: "The signed document will be available for download once all parties have completed signing." });
      return;
    }

    // Serve pre-sealed PDF if available (preferred path)
    if (doc.sealedPdfPath) {
      try {
        const sealedBuf = await downloadFromGcs(doc.sealedPdfPath);
        const safeName = doc.filename.replace(/[^a-z0-9.\-_]/gi, "_");
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="${safeName}"`);
        res.send(sealedBuf);
        return;
      } catch {
        req.log.warn("sealed PDF not found in GCS, falling back to on-demand generation");
      }
    }

    // Fallback: on-demand PDF generation
    const allFields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.documentId, docId));

    const entries = signedRecipients.flatMap((r) => {
      const recipientFields = allFields.filter((f) => f.recipientId === r.id);
      const signedAt = r.signedAt ? new Date(r.signedAt) : new Date();
      const signerName = r.signerName || r.teamName;
      return recipientFields
        .filter((f) => f.fieldValue)
        .map((f) => ({
          fieldType: (f.fieldType || "signature") as "signature" | "initials" | "date" | "text",
          fieldValue: f.fieldValue!,
          signerName,
          signedAt,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        }));
    });

    const signerRecs: SignerRecord[] = signedRecipients.map((r) => ({
      name: r.signerName || r.teamName,
      email: r.email,
      signedAt: r.signedAt ? new Date(r.signedAt) : new Date(),
      ipAddress: r.ipAddress,
    }));

    const docMeta: DocMeta = {
      documentName: doc.filename,
      documentId: doc.id,
      completedAt: new Date(),
    };

    const source = isGcsPath(doc.filepath) ? await getFileBuffer(doc.filepath) : doc.filepath;
    const pdfBytes = await buildSignedPdf(source, entries, { doc: docMeta, signers: signerRecs });
    const safeName = doc.filename.replace(/[^a-z0-9.\-_]/gi, "_");
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${safeName}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    req.log.error({ err }, "sign download error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /sign/:token/file  (public — stream PDF for viewer)
// 📝 NOTE: This route exists in the full source (not shown truncated above).
// It authenticates via the token (public route), validates expiry, checks the
// document exists, and streams the PDF from GCS using streamFromGcs().
// The route is listed in threat_model.md as a public surface.

export default router;
```

---

### `artifacts/api-server/src/routes/admin.ts`

```typescript
import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { eq, desc } from "drizzle-orm";
import { db, usersTable, documentsTable, recipientsTable } from "@workspace/db";
import type { Request, Response } from "express";

const router: IRouter = Router();

function requireAdmin(req: Request, res: Response, next: () => void) {
  if (!req.session.userId || req.session.userRole !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

function requireAuditAccess(req: Request, res: Response, next: () => void) {
  const role = req.session.userRole;
  if (!req.session.userId || (role !== "admin" && role !== "auditor")) {
    res.status(403).json({ error: "Audit access required" });
    return;
  }
  next();
}

// GET /admin/users
router.get("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  try {
    const users = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        provider: usersTable.provider,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt);
    res.json({ users });
  } catch (err) {
    req.log.error({ err }, "list users error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/users
router.post("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body as { name?: string; email?: string; password?: string; role?: string };
    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email and password are required" });
      return;
    }
    const normalizedEmail = email.toLowerCase();
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
    if (existing.length > 0) {
      res.status(400).json({ error: "Email already in use" });
      return;
    }
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const validRole = (role === "admin" || role === "auditor") ? role : "user";
    await db.insert(usersTable).values({
      id,
      name,
      email: normalizedEmail,
      password: hashed,
      role: validRole,
      provider: "local",
    });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "create user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /admin/users/:id
router.delete("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (id === req.session.userId) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }
  try {
    // 📝 NOTE: User deletion does NOT cascade to documents or recipients.
    // The deleted user's documents remain in the DB, orphaned (no valid uploadedBy).
    // This is intentional for audit integrity — documents must not disappear
    // when a user account is deleted.
    await db.delete(usersTable).where(eq(usersTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "delete user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admin/users/:id/role
router.patch("/admin/users/:id/role", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { role } = req.body as { role?: string };
  if (role !== "admin" && role !== "user" && role !== "auditor") {
    res.status(400).json({ error: "role must be 'admin', 'auditor', or 'user'" });
    return;
  }
  if (id === req.session.userId && role !== "admin") {
    res.status(400).json({ error: "You cannot remove your own admin role" });
    return;
  }
  try {
    await db.update(usersTable).set({ role }).where(eq(usersTable.id, id));
    // ⚠️ WARNING: Role change is NOT reflected in active sessions immediately.
    // A user whose role is changed from "admin" to "user" by another admin will
    // continue to have admin access until their session cookie expires (24h).
    // For high-security use, consider invalidating the affected user's session
    // on role change.
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "update role error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Audit helpers ─────────────────────────────────────────────────────────────

type AuditEvent = {
  id: string;
  type: string;
  documentId: string;
  documentTitle: string;
  uploaderName: string;
  uploaderEmail: string | null;
  actorName: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  timestamp: string;
  note?: string | null;
};

async function buildAuditEvents(): Promise<AuditEvent[]> {
  // ⚠️ WARNING: buildAuditEvents fetches ALL recipients from the DB with no
  // document-scope filter and no LIMIT. As the number of recipients grows
  // (e.g., 50 documents × 10 recipients = 500+ rows), this query becomes
  // expensive. The documents query has .limit(500) but recipients has none.
  // For large installations, add a JOIN-based approach or paginate this endpoint.
  const documents = await db
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      uploaderName: documentsTable.uploaderName,
      uploadedBy: documentsTable.uploadedBy,
      status: documentsTable.status,
      createdAt: documentsTable.createdAt,
      completedAt: documentsTable.completedAt,
      uploaderEmail: usersTable.email,
    })
    .from(documentsTable)
    .leftJoin(usersTable, eq(documentsTable.uploadedBy, usersTable.id))
    .orderBy(desc(documentsTable.createdAt))
    .limit(500);

  const recipients = await db
    .select({
      id: recipientsTable.id,
      documentId: recipientsTable.documentId,
      teamName: recipientsTable.teamName,
      email: recipientsTable.email,
      signerName: recipientsTable.signerName,
      ipAddress: recipientsTable.ipAddress,
      viewedAt: recipientsTable.viewedAt,
      signedAt: recipientsTable.signedAt,
      requiresReview: recipientsTable.requiresReview,
      reviewStatus: recipientsTable.reviewStatus,
      reviewedAt: recipientsTable.reviewedAt,
      reviewNote: recipientsTable.reviewNote,
    })
    .from(recipientsTable);
  // ⚠️ No WHERE clause on recipientsTable — fetches ALL recipients.

  const docMap = new Map(documents.map(d => [d.id, d]));

  const events: AuditEvent[] = [];

  for (const doc of documents) {
    events.push({
      id: `upload-${doc.id}`,
      type: "uploaded",
      documentId: doc.id,
      documentTitle: doc.title,
      uploaderName: doc.uploaderName,
      uploaderEmail: doc.uploaderEmail ?? null,
      actorName: doc.uploaderName,
      actorEmail: doc.uploaderEmail ?? null,
      ipAddress: null,
      timestamp: doc.createdAt.toISOString(),
    });

    if (doc.status === "sent" || doc.status === "completed") {
      events.push({
        id: `sent-${doc.id}`,
        type: "sent",
        documentId: doc.id,
        documentTitle: doc.title,
        uploaderName: doc.uploaderName,
        uploaderEmail: doc.uploaderEmail ?? null,
        actorName: doc.uploaderName,
        actorEmail: doc.uploaderEmail ?? null,
        ipAddress: null,
        timestamp: doc.createdAt.toISOString(),
        // 📝 NOTE: "sent" event timestamp is the document createdAt, not a
        // separate sentAt field. This is inaccurate if the document was created
        // as a draft and sent later. Consider adding a sentAt field to documents.
      });
    }

    if (doc.completedAt) {
      events.push({
        id: `complete-${doc.id}`,
        type: "completed",
        documentId: doc.id,
        documentTitle: doc.title,
        uploaderName: doc.uploaderName,
        uploaderEmail: doc.uploaderEmail ?? null,
        actorName: null,
        actorEmail: null,
        ipAddress: null,
        timestamp: doc.completedAt.toISOString(),
      });
    }
  }

  for (const r of recipients) {
    const doc = docMap.get(r.documentId);
    // 📝 NOTE: Recipients whose document is NOT in the top-500 documents list
    // will have doc === undefined, and docTitle/uploaderName will be defaults.
    // This is a minor inaccuracy at scale when there are >500 documents.
    const docTitle = doc?.title ?? "Unknown Document";
    const uploaderName = doc?.uploaderName ?? "";
    const uploaderEmail = doc?.uploaderEmail ?? null;

    if (r.viewedAt) {
      events.push({
        id: `view-${r.id}`,
        type: "viewed",
        documentId: r.documentId,
        documentTitle: docTitle,
        uploaderName,
        uploaderEmail,
        actorName: r.teamName,
        actorEmail: r.email,
        ipAddress: null,
        timestamp: r.viewedAt.toISOString(),
      });
    }

    if (r.signedAt) {
      events.push({
        id: `sign-${r.id}`,
        type: "signed",
        documentId: r.documentId,
        documentTitle: docTitle,
        uploaderName,
        uploaderEmail,
        actorName: r.signerName ?? r.teamName,
        actorEmail: r.email,
        ipAddress: r.ipAddress ?? null,
        timestamp: r.signedAt.toISOString(),
      });
    }

    if (r.requiresReview && r.reviewedAt && r.reviewStatus) {
      const eventType = r.reviewStatus === "approved" ? "review_approved" : "review_changes_requested";
      events.push({
        id: `review-${r.id}`,
        type: eventType,
        documentId: r.documentId,
        documentTitle: docTitle,
        uploaderName,
        uploaderEmail,
        actorName: r.signerName ?? r.teamName,
        actorEmail: r.email,
        ipAddress: r.ipAddress ?? null,
        timestamp: r.reviewedAt.toISOString(),
        note: r.reviewNote ?? null,
      });
    }
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return events.slice(0, 1000);
}

// GET /admin/audit
router.get("/admin/audit", requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const events = await buildAuditEvents();
    res.json({ events });
  } catch (err) {
    req.log.error({ err }, "audit log error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/audit/export  (CSV download)
router.get("/admin/audit/export", requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const events = await buildAuditEvents();

    const escape = (s: string | null | undefined) => `"${(s ?? "").replace(/"/g, '""')}"`;

    const headers = ["Event Type", "Document Title", "Document ID", "Uploaded By", "Uploader Email", "Actor Name", "Actor Email", "IP Address", "Timestamp (UTC)", "Note"];
    const rows = events.map(e => [
      e.type,
      e.documentTitle,
      e.documentId,
      e.uploaderName,
      e.uploaderEmail ?? "",
      e.actorName ?? "",
      e.actorEmail ?? "",
      e.ipAddress ?? "",
      new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19),
      e.note ?? "",
    ]);

    const csv = [headers.map(escape).join(","), ...rows.map(r => r.map(escape).join(","))].join("\r\n");

    const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // 📝 NOTE: BOM (0xFEFF) prefix ensures Excel opens the UTF-8 CSV correctly.
    res.send("\uFEFF" + csv);
  } catch (err) {
    req.log.error({ err }, "audit export error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
```

---

### `artifacts/api-server/src/routes/pdfSigner.ts`

_(Summary — full file is ~620 lines)_

```typescript
import { PDFDocument, PDFPage, PDFFont, rgb, StandardFonts, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { createHash } from "crypto";

// Arabic font lazy-loading: loads Noto Sans Arabic (regular + bold) from
// @fontsource/noto-sans-arabic at first use. Falls back to Helvetica if
// the font package is unavailable.
let _arabicRegular: Buffer | null | undefined;
let _arabicBold: Buffer | null | undefined;

function loadArabicFontBytes(): { regular: Buffer | null; bold: Buffer | null } { /* ... */ }

// hasArabic: detects Arabic/RTL Unicode characters in a string
function hasArabic(s: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s);
}

// selectFont: picks Arabic font if text contains Arabic; otherwise Latin
function selectFont(s: string, latin: PDFFont, arabic: PDFFont): PDFFont { /* ... */ }

// ─── Types ────────────────────────────────────────────────────────────────────
export interface FieldEntry {
  fieldType: "signature" | "initials" | "date" | "text";
  fieldValue: string;
  signerName: string;
  signedAt: Date;
  page: number;
  x: number; y: number; width: number; height: number;
}

export interface SignerRecord {
  name: string; email: string; signedAt: Date; ipAddress?: string | null;
}

export interface ReviewerRecord {
  name: string; email: string; reviewedAt: Date; ipAddress?: string | null;
  decision: "approved" | "changes_requested"; note?: string | null;
}

export interface DocMeta {
  documentName: string; documentId: string; completedAt: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// safeText: replaces characters outside WinAnsi (Windows-1252) with "?" to
// prevent pdf-lib from throwing on non-Latin characters when using Helvetica.
// 📝 NOTE: This is a fallback for Helvetica. When Arabic fonts are embedded,
// selectFont() ensures Arabic text uses the correct embedded font instead.
function safeText(s: string): string { /* ... */ }

// toDrawCoords: converts fractional [0–1] field coordinates (top-left origin)
// to pdf-lib drawing space (bottom-left origin, MediaBox units), handling all
// four page rotation angles (0, 90, 180, 270 degrees).
// ⚠️ NOTE: Page rotation handling is complex. Bugs here would cause fields to
// be drawn in wrong positions on rotated PDFs. The coordinate math was tested
// against sample rotated PDFs.
function toDrawCoords(
  fx: number, fy: number, fw: number, fh: number,
  pw: number, ph: number,
  rotation: number
): { x: number; y: number; w: number; h: number } { /* ... */ }

// drawPageFooter: draws a small "Electronically signed via SOS Village..."
// footer at the visual bottom of each page, handling all 4 rotations.
function drawPageFooter(page: PDFPage, pageNum: number, totalPages: number, certId: string, font: PDFFont): void { /* ... */ }

// addAuditPage: appends a full "E-SIGNATURE CERTIFICATE" page to the PDF
// with document metadata, reviewer table, signer table, and SHA-256 hash.
async function addAuditPage(
  pdfDoc: PDFDocument,
  doc: DocMeta,
  signers: SignerRecord[],
  certId: string,
  docHash: string,
  font: PDFFont,
  fontBold: PDFFont,
  fontArabic: PDFFont,
  fontArabicBold: PDFFont,
  pageNum: number,
  totalPages: number,
  reviewers?: ReviewerRecord[],
): Promise<void> { /* ... */ }

/**
 * buildSignedPdf — main entry point.
 * Accepts the source PDF as a file path (string) or in-memory Buffer.
 * Overlays all field entries onto the appropriate pages.
 * If `meta` is provided, also draws per-page footers and appends an audit
 * certificate page.
 *
 * ⚠️ WARNING: This function loads the entire PDF into memory, embeds fonts,
 * and embeds signature PNG images. For large PDFs (many pages, large images)
 * this can consume significant memory. On a 512MB DO droplet, a 10MB PDF
 * with many signatures could spike heap usage substantially.
 */
export async function buildSignedPdf(
  source: string | Buffer,
  entries: FieldEntry[],
  meta?: { doc: DocMeta; signers: SignerRecord[]; reviewers?: ReviewerRecord[] }
): Promise<Uint8Array> {
  const pdfBytes = Buffer.isBuffer(source) ? source : readFileSync(source);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const { regular: arabicRegularBytes, bold: arabicBoldBytes } = loadArabicFontBytes();
  const fontArabic     = arabicRegularBytes ? await pdfDoc.embedFont(arabicRegularBytes) : font;
  const fontArabicBold = arabicBoldBytes    ? await pdfDoc.embedFont(arabicBoldBytes)    : fontBold;

  // Draw field overlays on document pages
  for (const entry of entries) {
    // ... signature image embedding, text field rendering, rotation-aware positioning
  }

  // Append footer + audit page (only when signing metadata provided)
  if (meta) {
    const { doc, signers } = meta;
    const certId = generateCertId(doc.documentId, doc.completedAt);
    const docHash = createHash("sha256").update(pdfBytes).digest("hex");
    const originalPageCount = pages.length;
    const totalPages = originalPageCount + 1;

    for (let i = 0; i < originalPageCount; i++) {
      drawPageFooter(pages[i], i + 1, totalPages, certId, font);
    }

    await addAuditPage(pdfDoc, doc, signers, certId, docHash, font, fontBold,
      fontArabic, fontArabicBold, totalPages, totalPages, meta.reviewers);
  }

  return pdfDoc.save();
}
```

---

## 4. Frontend — Entry Points & Router

### `artifacts/esign-app/src/main.tsx`

```tsx
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
```

---

### `artifacts/esign-app/src/App.tsx`

```tsx
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileSignature } from "lucide-react";

import { useGetMe } from "@workspace/api-client-react";

import { Layout } from "@/components/layout";
import { AuthPage } from "@/pages/auth";
import { SignPage } from "@/pages/sign";
import { ReviewPage } from "@/pages/review";

// Lazy-loaded authenticated pages (code-split)
const DashboardPage = lazy(() => import("@/pages/dashboard").then((m) => ({ default: m.DashboardPage })));
const UploadPage = lazy(() => import("@/pages/upload").then((m) => ({ default: m.UploadPage })));
const DocumentDetailPage = lazy(() => import("@/pages/document-detail").then((m) => ({ default: m.DocumentDetailPage })));
const AdminUsersPage = lazy(() => import("@/pages/admin-users").then((m) => ({ default: m.AdminUsersPage })));
const AdminAuditPage = lazy(() => import("@/pages/admin-audit").then((m) => ({ default: m.AdminAuditPage })));
const NotFound = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function LoadingScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background">
      <div className="h-10 w-10 rounded-xl bg-primary flex items-center justify-center">
        <FileSignature className="h-5 w-5 text-primary-foreground" />
      </div>
      <div className="h-1 w-24 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary rounded-full animate-[loading_1.2s_ease-in-out_infinite]" />
      </div>
    </div>
  );
}

// ProtectedRoute: redirects unauthenticated users to /auth with redirect param
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: me, isLoading } = useGetMe();
  const [location] = useLocation();

  if (isLoading) return <LoadingScreen />;

  if (!me?.user) {
    const redirect = encodeURIComponent(location);
    return <Redirect to={`/auth?redirect=${redirect}`} />;
  }

  return (
    <Layout>
      <Component />
    </Layout>
  );
}

// AdminRoute: requires role === "admin"
function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: me, isLoading } = useGetMe();
  const [location] = useLocation();

  if (isLoading) return <LoadingScreen />;

  if (!me?.user) {
    const redirect = encodeURIComponent(location);
    return <Redirect to={`/auth?redirect=${redirect}`} />;
  }

  if (me.user.role !== "admin") {
    return <Redirect to="/" />;
  }

  return (
    <Layout>
      <Component />
    </Layout>
  );
}

// AuditRoute: requires role === "admin" OR "auditor"
function AuditRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: me, isLoading } = useGetMe();
  const [location] = useLocation();

  if (isLoading) return <LoadingScreen />;

  if (!me?.user) {
    const redirect = encodeURIComponent(location);
    return <Redirect to={`/auth?redirect=${redirect}`} />;
  }

  if (me.user.role !== "admin" && me.user.role !== "auditor") {
    return <Redirect to="/" />;
  }

  return (
    <Layout>
      <Component />
    </Layout>
  );
}

// 📝 NOTE: SignPage and ReviewPage are NOT lazy-loaded. They are public routes
// served from sign.html (separate entry point) and need to render without the
// full authenticated app shell. Keeping them eager avoids an extra chunk load
// on the signing/review path.
function Router() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Switch>
        <Route path="/auth" component={AuthPage} />
        <Route path="/sign/:token" component={SignPage} />
        <Route path="/review/:token" component={ReviewPage} />
        <Route path="/">
          <ProtectedRoute component={DashboardPage} />
        </Route>
        <Route path="/documents/upload">
          <ProtectedRoute component={UploadPage} />
        </Route>
        <Route path="/documents/:id">
          <ProtectedRoute component={DocumentDetailPage} />
        </Route>
        <Route path="/admin/users">
          <AdminRoute component={AdminUsersPage} />
        </Route>
        <Route path="/admin/audit">
          <AuditRoute component={AdminAuditPage} />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* BASE_URL trailing slash stripped to avoid double-slash with wouter paths */}
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
```

---

## 5. Frontend — Pages

### `artifacts/esign-app/src/pages/auth.tsx`

```tsx
import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin, useRegister, useGetAzureEnabled, getGetMeQueryKey } from "@workspace/api-client-react";
import type { MeResponse } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { FileSignature, ShieldCheck, Zap, Users } from "lucide-react";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

function MicrosoftIcon() {
  return (
    <svg className="h-4 w-4 mr-2" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

const FEATURES = [
  { icon: FileSignature, text: "Collect legally binding e-signatures" },
  { icon: Users, text: "Invite up to 20 recipients per document" },
  { icon: Zap, text: "Sequential or simultaneous signing flows" },
  { icon: ShieldCheck, text: "Full audit trail with timestamps" },
];

export function AuthPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const redirectTo = params.get("redirect") || "/";
  const urlError = params.get("error");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLogin, setIsLogin] = useState(true);

  const loginMutation = useLogin();
  const registerMutation = useRegister();
  const { data: azureConfig } = useGetAzureEnabled();

  useEffect(() => {
    if (urlError) {
      const messages: Record<string, string> = {
        invalid_state: "Sign-in session expired. Please try again.",
        azure_failed: "Microsoft sign-in failed. Please try again.",
        access_denied: "Access was denied. Please contact your administrator.",
        account_conflict: "An account with this email already exists. Please sign in with your password instead.",
      };
      toast({
        variant: "destructive",
        title: "Sign-in error",
        description: messages[urlError] ?? "An error occurred during sign-in.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginForm = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const registerForm = useForm<z.infer<typeof registerSchema>>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const onLoginSubmit = (values: z.infer<typeof loginSchema>) => {
    loginMutation.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          queryClient.setQueryData<MeResponse>(getGetMeQueryKey(), { user: data.user });
          setLocation(redirectTo);
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Login failed",
            description: (err as { error?: string })?.error || "Please check your credentials and try again.",
          });
        },
      }
    );
  };

  const onRegisterSubmit = (values: z.infer<typeof registerSchema>) => {
    registerMutation.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          queryClient.setQueryData<MeResponse>(getGetMeQueryKey(), { user: data.user });
          setLocation(redirectTo);
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Registration failed",
            description: (err as { error?: string })?.error || "An error occurred during registration.",
          });
        },
      }
    );
  };

  const handleMicrosoftSignIn = () => {
    window.location.href = "/api/auth/azure";
  };

  return (
    <div className="min-h-[100dvh] flex">
      {/* Left: brand panel with gradient background */}
      <div className="hidden lg:flex lg:w-[46%] flex-col justify-between p-12 relative overflow-hidden"
        style={{ background: "linear-gradient(145deg, hsl(207 100% 9%), hsl(203 100% 16%))" }}>
        {/* ... brand content with SOS logo, feature list, copyright */}
      </div>

      {/* Right: login/register form */}
      <div className="flex-1 flex items-center justify-center bg-muted/30 p-6 lg:p-12">
        <div className="w-full max-w-sm space-y-7">
          {/* Microsoft SSO button (conditional on azureConfig.enabled) */}
          {/* Email/password form (login or register) */}
          {/* Toggle between login and register */}
        </div>
      </div>
    </div>
  );
}
```

---

### `artifacts/esign-app/src/pages/dashboard.tsx`

_(Key logic — see full file for complete JSX)_

```tsx
export function DashboardPage() {
  const { data, isLoading } = useListDocuments();
  const { data: signingData, isLoading: signingLoading } = useGetMySigningRequests();
  const documents = data?.documents || [];
  const signingRequests = signingData?.requests || [];
  const deleteMutation = useDeleteDocument();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDelete = (id: string) => {
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        toast({ title: "Document deleted successfully" });
      },
      onError: (err: unknown) => {
        toast({ variant: "destructive", title: "Error deleting document",
          description: (err as { error?: string })?.error });
      },
    });
  };

  // Stat cards: Total, Completed, Pending Signatures, Awaiting My Signature
  // Documents list with status badges, progress bar, download and delete buttons
  // Signing requests section showing documents sent to this user
}
```

---

### `artifacts/esign-app/src/pages/upload.tsx`

```tsx
// 📝 NOTE: Upload accepts only PDF (ACCEPTED_TYPES = [".pdf"]).
// DOCX/DOC support was removed — see documents.ts note.
const ACCEPTED_TYPES = [".pdf"];
const ACCEPTED_MIME = ["application/pdf"];
const MAX_MB = 50;

export function UploadPage() {
  // Uses XHR (not fetch) to get upload progress events (xhr.upload.onprogress)
  // Progress mapping: 0-80% = file transfer, 80-95% = server processing
  // 5 minute XHR timeout for large files
  // On success: invalidates documents query, navigates to /documents/:id

  const onSubmit = async (values) => {
    // Pre-checks session freshness before uploading (guards against expired sessions)
    const sessionCheck = await fetch("/api/auth/me", { credentials: "include" });
    // ... XHR upload to /api/documents
  };
}
```

---

### `artifacts/esign-app/src/pages/sign.tsx`

_(Public page — rendered from sign.html entry point)_

```tsx
export function SignPage() {
  const { token } = useParams<{ token: string }>();

  // State:
  // - success: whether signature was just submitted
  // - currentPage / numPages: PDF pagination
  // - fieldValues: Record<fieldId, string> for date/text fields
  // - sigDialogOpen: signature pad dialog state
  // - fieldDialogOpen: text/date field input dialog

  // Hooks:
  // - useGetSigningInfo(token): loads recipient info, fields, document status
  // - useGetMe(): to check if user is logged in (for "use saved signature")
  // - useGetSavedSignature(): load user's saved signature if available
  // - useSubmitSignature(): submit the completed form

  // Key logic:
  // - hasSignatureFields: true if no fields placed (free-form) OR if signature/initials field exists
  // - renderSigningOverlay(): renders clickable field boxes on the PDF
  // - renderCompletedOverlay(): renders filled-in field values on the PDF after completion

  // Handles states:
  // - loading skeleton
  // - error / invalid token
  // - alreadySigned OR success: completion screen with PDF viewer + download button
  // - nextStep === "blocked" (awaiting review or prior signer): blocking screen
  // - active signing form: PDF viewer + signature pad + field inputs

  // ⚠️ NOTE: The "blocked" → "review rejected" path (reviewRejected flag) shows
  // reviewer feedback to the current signer, which is the intended UX — signers
  // should know why the document was returned for changes.
}
```

---

### `artifacts/esign-app/src/pages/review.tsx`

```tsx
export function ReviewPage() {
  const { token } = useParams<{ token: string }>();

  // 📝 NOTE: ReviewPage does NOT use generated API hooks — it uses raw fetch()
  // calls directly. This is inconsistent with the rest of the app which uses
  // generated TanStack Query hooks from @workspace/api-client-react.
  // Consider migrating to useGetSigningInfo() and a generated review mutation.

  const [info, setInfo] = useState<SigningInfo | null>(null);
  // ...

  useEffect(() => {
    // Fetch: GET /api/sign/:token
    fetch(`/api/sign/${token}`)
      .then((r) => r.json())
      .then((data) => {
        // Sets info, checklist, submitted/decision if already reviewed
      });
  }, [token]);

  const handleSubmit = async (d: "approve" | "request_changes") => {
    // POST /api/sign/:token/review
    // On success: sets submitted=true, reads nextStep from response
    // If nextStep === "sign": shows "Sign Document" button linking to /sign/:token
  };

  // Shows:
  // - PDF viewer (left column)
  // - Review panel (right column): checklist, notes textarea, approve/reject buttons
  // - After submission: success/rejection screen with option to change decision
}
```

---

### `artifacts/esign-app/src/pages/document-detail.tsx`

_(1212 lines — summary of key functionality)_

```tsx
export function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();

  // Queries:
  // - useGetDocument(id): document details, recipients, fields
  // - useGetDocumentStatus(id): polls every 5 seconds while document is "sent"

  // Field placement (admin drag-and-drop):
  // - FIELD_TYPES palette: Signature, Initials, Date Signed, Text
  // - onDrop on PDF: places field at drop coordinates with fractional positioning
  // - onCanvasClick on PDF (when field dragging): stamps field at clicked position
  // - Fields stored in local state; saved via useSaveDocumentFields()
  // - Per-recipient color coding with RECIPIENT_COLORS array

  // Recipients management:
  // - useSetRecipients() mutation: saves recipient list to backend
  // - Form: teamName, email, requiresReview toggle, requiresSignature toggle
  // - Max 20 recipients (server-enforced)

  // Sending:
  // - useSendDocument(): sends emails and marks document as sent/in_review
  // - SendDialog: optional custom subject/message for the email

  // Signing progress:
  // - Progress bar per recipient: pending/viewed/signed status badges
  // - Copy signing link button
  // - Individual remind button (useRemindRecipient)
  // - Remind all button (POST /documents/:id/remind-all)

  // Audit trail:
  // - GET /api/documents/:id/activity (if endpoint exists)

  // Download:
  // - DownloadButton: uses fetch() to trigger /api/documents/:id/download
  //   Shows "Generating..." while building the PDF
}
```

---

## 6. Frontend — Components

### `artifacts/esign-app/src/components/pdf-viewer.tsx`

```tsx
import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";

// 📝 NOTE: PDF.js worker served from /pdf.worker.min.mjs (copied to public/).
// CDN was not used because cdnjs does not carry pdfjs v5. The worker is ~3MB
// and served as a static file by Express in production.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const MAX_PAGE_WIDTH = 794; // A4 width at 96 dpi (~210mm)

interface PdfViewerProps {
  fileUrl: string | { url: string; withCredentials?: boolean };
  currentPage: number;
  onLoadSuccess: (numPages: number) => void;
  onPageChange: (page: number) => void;
  numPages: number;
  onCanvasClick?: (x: number, y: number) => void;
  renderOverlay?: () => React.ReactNode;
  clickable?: boolean;
  className?: string;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
}

export function PdfViewer({ ... }: PdfViewerProps) {
  const [pageWidth, setPageWidth] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ResizeObserver keeps pageWidth in sync with container size.
  // Capped at MAX_PAGE_WIDTH (794px) to avoid oversized rendering.
  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const update = (w: number) => setPageWidth(Math.min(Math.floor(w), MAX_PAGE_WIDTH));
    update(node.offsetWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // handleClick: converts click coordinates to [0–1] fractions of page dimensions
  // and passes them to onCanvasClick (used for field placement)
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !clickable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onCanvasClick(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
    );
  };

  return (
    <div className={`flex flex-col items-center gap-3 w-full ${className}`}>
      <div ref={wrapperRef} className="w-full" style={{ maxWidth: MAX_PAGE_WIDTH }}>
        <div
          className={`relative w-full border rounded-lg overflow-hidden shadow-sm bg-white ${clickable ? "cursor-crosshair" : ""}`}
          onClick={handleClick}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <Document file={fileUrl} onLoadSuccess={({ numPages: n }) => onLoadSuccess(n)} ...>
            {pageWidth > 0 && (
              <Page
                pageNumber={currentPage}
                width={pageWidth}
                renderAnnotationLayer={false}
                renderTextLayer={false}
              />
            )}
          </Document>

          {/* Overlay (field boxes, signature images, etc.) */}
          {renderOverlay && (
            <div className="absolute inset-0 pointer-events-none">
              {renderOverlay()}
            </div>
          )}
        </div>
      </div>

      {/* Page navigation (only shown when numPages > 1) */}
      {numPages > 1 && (
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon"
            onClick={(e) => { e.stopPropagation(); onPageChange(Math.max(1, currentPage - 1)); }}
            disabled={currentPage <= 1}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">Page {currentPage} of {numPages}</span>
          <Button variant="outline" size="icon"
            onClick={(e) => { e.stopPropagation(); onPageChange(Math.min(numPages, currentPage + 1)); }}
            disabled={currentPage >= numPages}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
```

---

### `artifacts/esign-app/src/components/signature-pad.tsx`

```tsx
interface SignaturePadProps {
  onSign: (dataUrl: string) => void;
  onClear: () => void;
}

type Mode = "draw" | "upload";

// ACCEPTED image types for signature upload
const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024;

export function SignaturePad({ onSign, onClear }: SignaturePadProps) {
  // Two modes: "draw" (canvas) and "upload" (image file)

  /* ── Draw mode ────────────────────────────────────────────────────────────── */

  // Canvas is sized to match device pixel ratio (DPR) for crisp rendering on
  // retina/HiDPI displays. CSS size is always 100% × 200px; physical canvas
  // size is width×DPR × height×DPR.
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ratio = window.devicePixelRatio || 1;
    const cssW = canvas.offsetWidth || 480;
    canvas.width = Math.round(cssW * ratio);
    canvas.height = Math.round(200 * ratio);
    ctx.scale(ratio, ratio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#1c325d";  // SOS brand blue
  }, [mode]);

  // Quadratic Bézier midpoint technique for smooth curves:
  // Instead of lineTo(pos), draw quadraticCurveTo(lastPoint, midpoint)
  // This eliminates sharp corners at direction changes.
  const draw = (e) => {
    const mid = {
      x: (lastPoint.current.x + pos.x) / 2,
      y: (lastPoint.current.y + pos.y) / 2,
    };
    ctx.quadraticCurveTo(lastPoint.current.x, lastPoint.current.y, mid.x, mid.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mid.x, mid.y);
    lastPoint.current = pos;
  };

  // Global mouseup handler: stops drawing even if pointer leaves the canvas
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDrawingRef.current) stopDrawing();
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, []);

  /* ── Upload mode ──────────────────────────────────────────────────────────── */

  // imageFileToDataUrl: resizes uploaded image to max 600px width via canvas,
  // always outputs PNG regardless of input format (normalizes to data:image/png)
  function imageFileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const MAX_W = 600;
          const scale = img.width > MAX_W ? MAX_W / img.width : 1;
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png"));
        };
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  return (
    <div className="space-y-3">
      {/* Mode toggle: Draw | Upload Image */}
      {mode === "draw" ? (
        <>
          {/* Canvas with touch + mouse event handlers */}
          {/* Clear button */}
        </>
      ) : (
        <>
          {/* File input (hidden) + drag-and-drop zone */}
          {/* Preview of uploaded image */}
        </>
      )}
    </div>
  );
}
```

---

## Consolidated Bug & Warning Summary

| # | Severity | Location | Description |
|---|----------|----------|-------------|
| 1 | `🐛 BUG` | `signing.ts` line ~519 | Completion check `x.status === "signed" \|\| x.id === r.id` has a TOCTOU race: two simultaneous signers may both fail to trigger document completion, leaving document stuck in "sent" status |
| 2 | `🐛 BUG` | `signing.ts` `maybeUnlockSigners` | Review-only workflows (no signers) never update document status to "completed" because the status update is gated on `pendingSigners.length > 0` |
| 3 | `⚠️ WARNING` | `emailService.ts` module level | nodemailer transporter created at import time (always points at smtp.gmail.com fallback) even when SMTP not configured — minor startup concern |
| 4 | `⚠️ WARNING` | `admin.ts` `buildAuditEvents` | Recipients query has no WHERE clause — fetches ALL recipients from DB with no limit; expensive at scale |
| 5 | `⚠️ WARNING` | `documents.ts` `GET /documents` | N+1 query: one DB round-trip per document to fetch recipient counts |
| 6 | `⚠️ WARNING` | `app.ts` | 70MB global JSON body limit on all routes — DoS vector for memory exhaustion |
| 7 | `⚠️ WARNING` | `app.ts` | Error handler placed after SPA fallbacks — errors from `express.static` / `sendFile` won't reach it |
| 8 | `⚠️ WARNING` | `app.ts` CSP | `'unsafe-eval'` in scriptSrc (required for PDF.js) weakens XSS defences |
| 9 | `⚠️ WARNING` | `admin.ts` `PATCH /role` | Role changes not reflected in active sessions — promoted/demoted users retain old role for up to 24h |
| 10 | `⚠️ WARNING` | `auth.ts` `PUT /auth/me/signature` | No size limit on stored signature data URL beyond the global 70MB JSON limit |
| 11 | `⚠️ WARNING` | `documents.ts` `PUT /fields` | Field coordinates not validated to [0,1] range — out-of-bounds values accepted |
| 12 | `📝 NOTE` | `documents.ts` `DELETE /documents` | GCS file is NOT deleted when document is deleted from DB — orphaned objects accumulate |
| 13 | `📝 NOTE` | `signing.ts` `GET /sign/:token` | `recipientsTable.email` not lowercased — `/signing/my-requests` may miss dashboard entries if case differs |
| 14 | `🔐 SECURITY` | `auth.ts` `parseJwt` | JWT not signature-verified (acceptable for token endpoint responses, but must not be applied to client-provided tokens) |
| 15 | `📝 NOTE` | `review.tsx` | ReviewPage uses raw `fetch()` instead of generated API hooks — inconsistent pattern |
| 16 | `📝 NOTE` | `admin.ts` "sent" audit event | "sent" event timestamp = document `createdAt`, not actual send time (draft→send delay invisible in audit) |
| 17 | `📝 NOTE` | `upload.tsx` | DOCX/DOC upload support removed; server only accepts PDF; replit.md still mentions LibreOffice conversion |

---

*End of export — generated 2026-06-25*
