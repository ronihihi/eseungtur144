# syntax=docker/dockerfile:1
FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app

# ── Build ───────────────────────────────────────────────────────────────────
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build
RUN pnpm --filter @workspace/esign-app run build
# Produce a lean, production-only copy of the API package with its
# node_modules pre-pruned (no devDependencies, no other workspace packages).
RUN pnpm --filter @workspace/api-server deploy --prod /prod/api

# ── Production ──────────────────────────────────────────────────────────────
FROM node:24-slim AS production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# API bundle + pruned node_modules from the deploy step
COPY --from=build /prod/api ./

# Built React frontend — served as static files by Express (see app.ts)
COPY --from=build /app/artifacts/esign-app/dist/public ./public

EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
