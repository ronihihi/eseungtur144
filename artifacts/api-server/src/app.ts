```ts
import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import helmet from "helmet";
import connectPgSimple from "connect-pg-simple";

import router from "./routes";
import { logger } from "./lib/logger";

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
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
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

const allowedOrigins = isProduction
  ? configuredOrigins
  : [...configuredOrigins, ...developmentOrigins];

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

const sessionStore = new PgStore({
  conString: databaseUrl,
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

// ── Not-found handler ────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} was not found`,
  });
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
```
