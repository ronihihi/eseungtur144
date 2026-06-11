import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import fs from "fs";

// PORT and BASE_PATH are only required at dev/preview runtime, not during `vite build`.
// Use safe defaults so the production build phase succeeds without them.
const port = process.env.PORT ? Number(process.env.PORT) : 5173;
const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    {
      name: "sign-route-noindex",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url ?? "";
          if (url.startsWith("/sign/") || url === "/sign") {
            const signHtml = path.resolve(import.meta.dirname, "sign.html");
            fs.readFile(signHtml, "utf-8", (err, content) => {
              if (err) return next();
              server.transformIndexHtml(url, content).then((transformed) => {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(transformed);
              }).catch(() => next());
            });
            return;
          }
          next();
        });
      },
      // After the production build, generate sign.html from index.html with noindex injected.
      // This avoids a multi-page rollupOptions.input which triggers EISDIR on Vite 7 in production.
      closeBundle() {
        if (process.env.NODE_ENV !== "production") return;
        const outDir = path.resolve(import.meta.dirname, "dist/public");
        const indexPath = path.join(outDir, "index.html");
        const signPath = path.join(outDir, "sign.html");
        try {
          const indexHtml = fs.readFileSync(indexPath, "utf-8");
          const signHtml = indexHtml.replace(
            "<head>",
            '<head>\n    <meta name="robots" content="noindex, nofollow, noarchive" />',
          );
          fs.writeFileSync(signPath, signHtml);
        } catch {
          // dist may not exist when not in a build context
        }
      },
    },
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-pdf") || id.includes("node_modules/pdfjs-dist")) {
            return "vendor-pdf";
          }
          if (id.includes("node_modules/@tanstack")) {
            return "vendor-query";
          }
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/")) {
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
