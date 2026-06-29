import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const rawUrl = process.env.DO_DATABASE_URL || process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error("DO_DATABASE_URL (or DATABASE_URL) must be set.");
}

// Strip sslmode from the URL so pg-connection-string does NOT override the ssl
// option below (pg ≥8.12 promotes sslmode=require to verify-full, breaking
// connections to managed DBs that use self-signed CA chains).
const connectionString = rawUrl
  .replace(/[?&]sslmode=[^&]*/g, "")
  .replace(/\?&/, "?")
  .replace(/[?&]$/, "");

// LOAD-B2: Tuned pool — bounded size, idle/connection timeouts, and a
// statement_timeout so slow queries fail fast rather than hang.
// SEC-A1 NOTE: rejectUnauthorized is false because DATABASE_CA_CERT currently
// holds a cert that does not match the DO managed-database chain. To enable
// full TLS verification, replace DATABASE_CA_CERT with the correct DO CA cert
// (download from DO dashboard → database → CA certificate).
export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

export const db = drizzle(pool, { schema });

export * from "./schema";
