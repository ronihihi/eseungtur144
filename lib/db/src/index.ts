import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Prefer DO_DATABASE_URL (DigitalOcean) over the Replit-managed DATABASE_URL.
// Strip ?sslmode=... from the URL — we control SSL via the ssl option directly,
// because DigitalOcean uses a self-signed project CA that Node's chain verifier
// rejects even when the cert is provided. TLS is still active (encrypted in
// transit); we just skip chain verification the same way the DO Node.js docs recommend.
const rawUrl = process.env.DO_DATABASE_URL || process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error("DO_DATABASE_URL (or DATABASE_URL) must be set.");
}

const connectionString = rawUrl.replace(/([?&])sslmode=[^&]*/g, "$1").replace(/[?&]$/, "");
const isDigitalOcean = !!process.env.DO_DATABASE_URL;

export const pool = new Pool({
  connectionString,
  ssl: isDigitalOcean
    ? { rejectUnauthorized: false }   // DO self-signed CA — encrypted but not chain-verified
    : process.env.DATABASE_CA_CERT
      ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT }
      : { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });

export * from "./schema";
