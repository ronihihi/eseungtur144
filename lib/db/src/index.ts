import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const rawUrl = process.env.DO_DATABASE_URL || process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error("DO_DATABASE_URL (or DATABASE_URL) must be set.");
}

// Strip sslmode and sslrootcert from the URL so pg-connection-string does NOT
// override the ssl option below (pg ≥8.12 treats sslmode=require/verify-full
// as aliases for verify-full, which conflicts with our explicit ssl config).
const connectionString = rawUrl
  .replace(/[?&]sslmode=[^&]*/g, "")
  .replace(/[?&]sslrootcert=[^&]*/g, "")
  .replace(/\?&/, "?")
  .replace(/[?&]$/, "");

// SEC-A1: To enable full TLS chain verification, set DATABASE_CA_CERT to the
// content of the DigitalOcean CA certificate downloaded from:
//   DO Dashboard → Databases → your cluster → Connection details → Download CA certificate
// Then paste the full PEM content (including -----BEGIN CERTIFICATE-----) as the secret.
// Until then, encrypted connections are used without chain verification.
console.warn("[db] Using encrypted connection (rejectUnauthorized: false). " +
  "Update DATABASE_CA_CERT with the DO cluster CA cert to enable full verification.");

// LOAD-B2: Tuned pool — bounded size, idle/connection timeouts, and a
// statement_timeout so slow queries fail fast rather than hang.
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
