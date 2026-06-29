import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const rawUrl = process.env.DO_DATABASE_URL || process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error("DO_DATABASE_URL (or DATABASE_URL) must be set.");
}

// SEC-A1: When DATABASE_CA_CERT is provided and non-empty, use it for full TLS
// chain verification. Otherwise fall back to encrypted-but-unverified (the DO
// managed-database default; cert pinning can be added once the correct DO CA
// cert is confirmed and stored in the secret).
const ca = process.env.DATABASE_CA_CERT || "";

const ssl: pg.ConnectionConfig["ssl"] = ca
  ? { rejectUnauthorized: true, ca }
  : { rejectUnauthorized: false };

if (!ca) {
  console.warn("[db] DATABASE_CA_CERT not set — TLS chain verification disabled");
}

// LOAD-B2: Tuned pool — bounded size, idle/connection timeouts, and a
// statement_timeout so slow queries fail fast rather than hang.
export const pool = new Pool({
  connectionString: rawUrl,
  ssl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

export const db = drizzle(pool, { schema });

export * from "./schema";
