import type { Request } from "express";

export function getAppBaseUrl(req: Request): string {
  // APP_URL takes priority; APP_ORIGIN is the CORS-config name used in app.yaml —
  // accept both so signing links work regardless of which env var is set.
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.split(",")[0].trim().replace(/\/+$/, "");
  const protocol = req.protocol || "https";
  const host = req.get("host") || "localhost";
  return `${protocol}://${host}`;
}
