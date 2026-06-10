# syntax=docker/dockerfile:1.7
#
# civfix API production image (multi-stage).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (civfix-backend/), NOT services/api/. The API is a pnpm workspace
# package that depends on @civfix/shared (installed from the private registry repo.civfix.org via the
# root .npmrc), so the build needs the root manifests + pnpm-lock.yaml + .npmrc + packages/ in the
# context. The compose file sets
# `build.context: ../..` and `build.dockerfile: services/api/Dockerfile` accordingly. To build by hand
# from the repo root:
#     docker build -f services/api/Dockerfile -t civfix/api:latest .
#
# Stages:
#   base    pinned Node 22 (Debian bookworm-slim, glibc) + corepack-pinned pnpm.
#   build   install the FULL workspace (incl. dev tooling), build shared -> api with turbo/tsup, then
#           `pnpm deploy --prod` the API into a self-contained, dev-pruned directory (/out) whose
#           node_modules contains only production deps with @civfix/shared resolved via the pnpm store.
#   runtime copy /out, drop privileges, expose the port, healthcheck GET /healthz.
#
# Why deploy: tsup keeps @civfix/shared EXTERNAL (skipNodeModulesBundle), so the runtime needs the shared
# package resolvable in node_modules. `pnpm deploy` produces exactly that (shared injected + prod-only
# deps), so the runtime image carries no build toolchain.

# ----------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    # Keep pnpm output terse + deterministic in CI.
    CI=true
# corepack ships with Node 22; pin pnpm to the version in the root package.json packageManager field.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ----------------------------------------------------------------------------------------------------
FROM base AS build
# Copy the whole workspace (context = repo root). The .dockerignore keeps node_modules/dist/tests out.
COPY . .
# Install the FULL workspace (dev deps included: tsup/turbo are needed to build). A BuildKit cache mount
# keeps the pnpm store warm across builds. --frozen-lockfile fails the build if the lockfile is stale.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build shared -> api (turbo resolves the order; tsup emits dist/). Only the API graph is needed.
RUN pnpm --filter @civfix/api... build
# Produce a self-contained, production-pruned deployment of just the API at /out (shared injected).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @civfix/api --prod deploy /out

# ----------------------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8080
# Run as the unprivileged `node` user that the base image already provides.
WORKDIR /app
# Copy only the pruned deployment (dist + drizzle SQL + prod node_modules incl. @civfix/shared).
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080
# Liveness: GET /healthz is pure (no DB/Redis) and returns 200 while the process is up. Uses Node's
# global fetch (Node 22) so the slim image needs no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# main.js calls start(): init error reporting, listen on PORT, install SIGTERM/SIGINT graceful shutdown.
CMD ["node", "dist/main.js"]
