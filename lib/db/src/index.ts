import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const rawUrl = process.env.DO_DATABASE_URL || process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error("DO_DATABASE_URL (or DATABASE_URL) must be set.");
}

const connectionString = rawUrl.replace(/([?&])sslmode=[^&]*/g, "$1").replace(/[?&]$/, "");

const isDigitalOcean =
  !!process.env.DO_DATABASE_URL ||
  connectionString.includes("digitalocean.com") ||
  connectionString.includes("db.ondigitalocean.com");

// SEC-A1: Use DATABASE_CA_CERT for full chain verification when available.
// Falls back to encrypted-but-unverified only when no cert is provided.
const ca = process.env.DATABASE_CA_CERT;

function buildSsl(): object {
  if (ca) {
    return { rejectUnauthorized: true, ca };
  }
  if (!ca && isDigitalOcean) {
    // intentional — warning emitted below after pool creation
  }
  return { rejectUnauthorized: false };
}

// LOAD-B2: Tuned pool — bounded size, idle/connection timeouts, and a
// server-side statement_timeout so slow queries fail fast rather than hang.
export const pool = new Pool({
  connectionString,
  ssl: buildSsl(),
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

if (!ca) {
  console.warn("[db] WARNING: DATABASE_CA_CERT not set — TLS chain verification disabled");
}

export const db = drizzle(pool, { schema });

export * from "./schema";
