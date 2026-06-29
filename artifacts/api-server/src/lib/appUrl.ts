import type { Request } from "express";

export function getAppBaseUrl(req: Request): string {
  // 1. Explicit override — highest priority. Set APP_URL to your production
  //    domain (e.g. https://e-signature.sos-palestine.org) and all email links
  //    will use it regardless of proxy headers.
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");

  // 2. APP_ORIGIN is the CORS-config name used in app.yaml — accept both.
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.split(",")[0].trim().replace(/\/+$/, "");

  // 3. Replit provides the public domain(s) via REPLIT_DOMAINS.
  //    Use the first one if available (comma-separated list).
  if (process.env.REPLIT_DOMAINS) {
    const first = process.env.REPLIT_DOMAINS.split(",")[0].trim();
    if (first) return `https://${first}`;
  }

  // 4. Honour the X-Forwarded-Proto / X-Forwarded-Host headers set by the
  //    reverse proxy. This works in both the Replit dev proxy and most cloud
  //    load-balancers (DO, nginx, Caddy). Falls back to req.protocol / host.
  const proto =
    (req.get("x-forwarded-proto") ?? "").split(",")[0].trim() ||
    req.protocol ||
    "https";
  const host =
    (req.get("x-forwarded-host") ?? "").split(",")[0].trim() ||
    req.get("host") ||
    "localhost";

  return `${proto}://${host}`;
}
