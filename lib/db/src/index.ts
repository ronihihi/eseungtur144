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
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !ca) {
  throw new Error(
    "DATABASE_CA_CERT must be set in production — refusing to start with unverified TLS.",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: ca
    ? { rejectUnauthorized: true, ca }
    : { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });

export * from "./schema";
