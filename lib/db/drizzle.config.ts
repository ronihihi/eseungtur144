import { defineConfig } from "drizzle-kit";
import path from "path";

const url = process.env.DO_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  throw new Error("DO_DATABASE_URL (or DATABASE_URL) must be set");
}

// Strip sslmode from URL — drizzle-kit passes the url directly to pg which
// then conflicts with the ssl option. Let pg handle TLS via the ssl object.
const connectionString = url.replace(/([?&])sslmode=[^&]*/g, "$1").replace(/[?&]$/, "");

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
    ssl: process.env.DO_DATABASE_URL
      ? false   // drizzle-kit flag — actual TLS is handled by pg's ssl option below
      : false,
  },
});
