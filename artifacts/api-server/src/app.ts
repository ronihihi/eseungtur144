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

// Trust the DigitalOcean reverse proxy so Express correctly detects HTTPS,
// secure cookies, the client IP address, and the original request protocol.
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
          url: req.url?.split("?")[0],
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
    // X-Frame-Options: SAMEORIGIN — prevents clickjacking from external origins
    frameguard: { action: "sameorigin" },

    // X-Content-Type-Options: nosniff — prevents MIME sniffing attacks
    noSniff: true,

    // Referrer-Policy — only send origin on cross-origin requests, never full URL
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },

    // Cross-Origin-Resource-Policy — restrict resource loading to same origin
    crossOriginResourcePolicy: { policy: "same-origin" },

    // Cross-Origin-Opener-Policy — isolate browsing context from other origins
    crossOriginOpenerPolicy: { policy: "same-origin" },

    // Cross-Origin-Embedder-Policy — all cross-origin resources must opt in
    crossOriginEmbedderPolicy: { policy: "require-corp" },

    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        workerSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        // Allow embedding only from same origin (consistent with X-Frame-Options)
        frameAncestors: ["'self'"],
        // Force HTTPS for all resources
        upgradeInsecureRequests: [],
      },
    },
  }),
);

// Permissions-Policy — disable powerful browser APIs not needed by this app
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  );
  next();
});

// ── CORS configuration ───────────────────────────────────────────────────────
//
// APP_ORIGIN can contain one origin:
//
// APP_ORIGIN=https://your-app.ondigitalocean.app
//
// It can also contain multiple comma-separated origins:
//
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

// Replit preview domains — auto-detected from REPLIT_DOMAINS / REPLIT_DEV_DOMAIN.
// These are only added in development so they never affect the production allow-list.
const replitOrigins = [
  ...(process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => `https://${d}`),
  ...(process.env.REPLIT_DEV_DOMAIN
    ? [`https://${process.env.REPLIT_DEV_DOMAIN}`]
    : []),
].filter((v, i, a) => a.indexOf(v) === i); // dedupe

// In production, include Replit platform domains (REPLIT_DOMAINS) alongside any
// manually configured APP_ORIGIN. This lets the app run correctly on Replit
// autoscale deployments without requiring a separate APP_ORIGIN secret.
const allowedOrigins = isProduction
  ? [...configuredOrigins, ...replitOrigins]
  : [...configuredOrigins, ...developmentOrigins, ...replitOrigins];

if (isProduction && allowedOrigins.length === 0) {
  logger.warn(
    "No allowed origins configured in production — set APP_ORIGIN. Running without CORS restrictions.",
  );
}

app.use(
  cors({
    credentials: true,

    origin(origin, callback) {
      // Requests without an Origin header can come from server-to-server
      // services, health checks, curl, or internal platform requests.
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
        {
          origin: normalizedOrigin,
        },
        "Blocked request from unauthorized CORS origin",
      );

      callback(
        new Error(`CORS: origin "${normalizedOrigin}" is not allowed`),
      );
    },
  }),
);

// ── Request body limits ──────────────────────────────────────────────────────

app.use(
  express.json({
    limit: "1mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb",
  }),
);

// ── PostgreSQL session store ─────────────────────────────────────────────────

const PgStore = connectPgSimple(session);

const sessionStore = new PgStore({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 60 * 60,
});

sessionStore.on("error", (error) => {
  logger.error(
    {
      error,
    },
    "PostgreSQL session store error",
  );
});

app.use(
  session({
    name: "esign.sid",
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: isProduction,

    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

// ── Health check ─────────────────────────────────────────────────────────────

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
// Scoped to /api so that non-API paths fall through to the frontend static files.

app.use("/api", (req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} was not found`,
  });
});

// ── Frontend static files ─────────────────────────────────────────────────────
// In production the React build is copied to ./public (one level up from ./dist/).
// In development this directory won't exist, so express.static is a no-op.

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

app.use(express.static(publicDir));

// /sign/* uses sign.html (noindex meta tag); everything else uses index.html.
app.use("/sign", (_req: express.Request, res: express.Response) => {
  res.sendFile(path.join(publicDir, "sign.html"));
});

app.use((_req: express.Request, res: express.Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ── Central error handler ────────────────────────────────────────────────────

app.use(
  (
    error: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error(
      {
        error,
        method: req.method,
        url: req.originalUrl,
      },
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
