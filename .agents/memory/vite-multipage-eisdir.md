---
name: Vite multi-page EISDIR fix
description: Why multi-page rollupOptions.input causes EISDIR in production builds on Vite 7, and the correct fix.
---

## The rule

Never use `rollupOptions.input` with multiple HTML entry points in Vite 7 production builds for this project. Use a `closeBundle` plugin hook to generate additional HTML variants from the built `index.html` instead.

**Why:** Vite 7's `vite:build-html` plugin's `processAssetUrl`/`fileToBuiltUrl` path hits EISDIR when processing HTML files listed as multi-page inputs in the deployment container (even though local builds succeed). Root-relative hrefs like `href="/"` in `<link>` tags and possibly anchor tags in static-shell HTML trigger it. The production deployment container and local dev container resolve paths differently enough that the local build succeeds while the deployment build fails.

**How to apply:** When a second HTML entry is needed (e.g. `sign.html` for noindex), generate it as a post-build artifact by reading the built `index.html` and patching it in a `closeBundle` hook gated on `NODE_ENV === "production"`. The source `sign.html` file (used by the dev middleware) stays in the project root for dev-mode serving, but is NOT included in `rollupOptions.input`.

## Pattern

```ts
// In the sign-route-noindex plugin:
closeBundle() {
  if (process.env.NODE_ENV !== "production") return;
  const outDir = path.resolve(import.meta.dirname, "dist/public");
  const indexHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf-8");
  const signHtml = indexHtml.replace(
    "<head>",
    '<head>\n    <meta name="robots" content="noindex, nofollow, noarchive" />',
  );
  fs.writeFileSync(path.join(outDir, "sign.html"), signHtml);
}
```

## Diagnosis trail

- The old `vite.config.ts` threw on missing `PORT`/`BASE_PATH`, masking the underlying EISDIR in deployment.
- Once safe defaults were added, the config no longer threw early, and the real EISDIR surfaced.
- The error is in `ModuleLoader.addModuleSource` → `transform` (vite:build-html plugin) → `Promise.all` → `processAssetUrl` → `fileToBuiltUrl` → `readFile` on a directory path.
- Removing `rollupOptions.input` eliminates the multi-page HTML transform path entirely.
