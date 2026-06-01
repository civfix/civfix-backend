# syntax=docker/dockerfile:1.7
#
# civfix media-worker production image (multi-stage).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (civfix-backend/). The worker is a pnpm workspace package that
# (a) inlines @civfix/api + @civfix/shared at BUILD time from their SOURCE (tsup noExternal), and
# (b) keeps the native / heavy runtime deps EXTERNAL (sharp, ffmpeg-static, ffprobe-static, execa,
# exifr, pg-boss, postgres, drizzle-orm, @sentry/node, @aws-sdk/*). So the build needs the root
# manifests + lockfile + shared/ + services/api/ (its source) in the context, and the runtime needs the
# external deps installed for THIS platform. Build by hand from the repo root:
#     docker build -f services/media-worker/Dockerfile -t civfix/media-worker:latest .
#
# FFMPEG / SHARP IN-CONTAINER (the key correctness point):
#   * ffmpeg-static + ffprobe-static download self-contained, STATICALLY-LINKED linux-x64 binaries on
#     install (postinstall). They need no system ffmpeg and no extra shared libs, so the slim base is
#     sufficient; the worker resolves them via `import ffmpegStatic from "ffmpeg-static"` -> `.path` at
#     node_modules/ffmpeg-static/... . We deliberately do NOT `apt-get install ffmpeg` (that would be a
#     second, unused copy); the vendored static binaries are the design.
#   * sharp 0.33.x ships prebuilt linux-x64 binaries (@img/sharp-linux-x64) that run on glibc, which the
#     Debian bookworm base provides. No build toolchain or libvips apt package is required.
#   Both are installed INSIDE this linux image (never copied from the host), so the platform is correct.
#
# Stages:
#   base    pinned Node 22 (bookworm-slim, glibc) + corepack-pinned pnpm.
#   build   install the FULL workspace, build shared -> api(src is inlined) -> worker, then
#           `pnpm deploy --prod` the worker into a self-contained, dev-pruned /out.
#   runtime copy /out, drop privileges, run the worker. (No port / no HTTP healthcheck: the worker is a
#           queue consumer; liveness is observed via pg-boss + logs. Docker restarts it on exit.)

# ----------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ----------------------------------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build shared -> api -> worker (the worker bundle inlines the api/shared sources). The trailing `...`
# selects the worker AND its workspace dependencies, built in order.
RUN pnpm --filter @civfix/media-worker... build
# Production-pruned, self-contained deployment of just the worker at /out. The native/external deps
# (sharp, ffmpeg-static, ffprobe-static, ...) are installed here for linux-x64 and carried into runtime.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @civfix/media-worker --prod deploy /out

# ----------------------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
# No EXPOSE / HEALTHCHECK: the worker opens no socket. It consumes the Jobs queue and exits non-zero on
# fatal error, so `restart: unless-stopped` in compose recovers it. main.js installs SIGTERM/SIGINT
# graceful shutdown (drain the queue, then tear down the DB pool + telemetry).
CMD ["node", "dist/main.js"]
