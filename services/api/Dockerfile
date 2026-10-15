# syntax=docker/dockerfile:1.7
#
# civfix API production image (multi-stage).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (civfix-backend/), NOT services/api/. The API is a pnpm workspace
# package that depends on @civfix/shared (installed from the private registry repo.civfix.org via the
# root .npmrc), so the build needs the root manifests + pnpm-lock.yaml + .npmrc + packages/ in the
# context. CI builds it that way (.github/workflows/build-images.yml); to build by hand from the repo
# root:
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

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    # Keep pnpm output terse + deterministic in CI.
    CI=true
# corepack ships with Node 22; pin pnpm to the version in the root package.json packageManager field.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
# The .dockerignore keeps node_modules/dist/tests out of this copy.
COPY . .
# Dev deps are needed here: tsup/turbo do the build. --frozen-lockfile fails the build on a stale
# lockfile.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# The trailing `...` builds the API and its workspace deps only.
RUN pnpm --filter @civfix/api... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @civfix/api --prod deploy /out

FROM node:22-bookworm-slim AS runtime
# No pnpm or corepack shims here: pnpm would reinstall /app/node_modules in place and empty it, which
# took down the dependency tree of a live prod container on 2026-09-23. Run db scripts with
# `node dist/db/<script>.js`.
RUN rm -rf /usr/local/bin/corepack /usr/local/lib/node_modules/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# SERVICE_VERSION is the RELEASE IDENTITY and it is baked in at BUILD time on purpose. It is the
# GlitchTip `release` (src/server.ts), so without it every production error report is tagged "0.0.0" and
# cannot be attributed to a build. It belongs to the IMAGE rather than to the deploy because the image is
# promoted: staging and prod run the same artifact and must therefore report the same version. CI passes
# the full commit sha (.github/workflows/build-images.yml); a local `docker build` leaves the dev default.
ARG SERVICE_VERSION=0.0.0
ENV NODE_ENV=production \
    PORT=8080 \
    SERVICE_VERSION=${SERVICE_VERSION}
# Run as the unprivileged `node` user that the base image already provides.
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080
# Liveness: GET /healthz is pure (no DB/Redis) and returns 200 while the process is up. Uses Node's
# global fetch (Node 22) so the slim image needs no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
