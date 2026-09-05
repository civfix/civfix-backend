# syntax=docker/dockerfile:1.7
#
# civfix media-worker production image (multi-stage).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (civfix-backend/). The worker is a pnpm workspace package that
# (a) inlines @civfix/api (workspace source) + @civfix/shared (from the private registry repo.civfix.org)
# at BUILD time (tsup noExternal), and
# (b) keeps the native / heavy runtime deps EXTERNAL (sharp, execa, exifr, pg-boss, postgres,
# drizzle-orm, undici, @sentry/node, @aws-sdk/*). So the build needs the root
# manifests + lockfile + .npmrc + services/api/ (its source) in the context, and the runtime needs the
# external deps installed for THIS platform. Build by hand from the repo root:
#     docker build -f services/media-worker/Dockerfile -t civfix/media-worker:latest .
#
# FFMPEG / SHARP IN-CONTAINER (the key correctness point):
#   * FFMPEG IS PINNED AND CHECKSUMMED HERE, not taken from npm (audit H8). ffprobe-static@3.1.0 ships
#     an FFmpeg 4.0.2 binary from 2018 — the tool that must interpret untrusted container bytes — with
#     no channel for the demuxer memory-safety fixes released since. The `ffmpeg` stage below downloads
#     ONE pinned release (FFMPEG_URL/FFMPEG_SHA256 ARGs), verifies its SHA-256 and fails the build on a
#     mismatch. The runtime stage exports FFMPEG_PATH/FFPROBE_PATH, which sandbox/binaries.ts REQUIRES
#     in production (the npm static packages are devDependencies and are pruned out of this image by
#     `pnpm --prod deploy`, so there is no silent fallback to the 2018 build).
#     BUMPING IT: pick a newer asset from the same release feed, put its URL in FFMPEG_URL, and set
#     FFMPEG_SHA256 to the `sha256sum` of the downloaded file. BtbN prunes old dated autobuild tags, so
#     a stale pin eventually 404s the build — that is a loud failure, never a silent downgrade.
#   * sharp 0.33.x ships prebuilt linux-x64 binaries (@img/sharp-linux-x64) that run on glibc, which the
#     Debian bookworm base provides. No build toolchain or libvips apt package is required.
#   Both are installed INSIDE this linux image (never copied from the host), so the platform is correct.
#
# DECODER PRIVILEGE SEPARATION (audit H7): the runtime stage provisions a SECOND, credential-less user
# (mediatools, uid/gid 1001) and puts `node` in its group. Node holds DATABASE_URL and the R2 keys; every
# untrusted-byte parser — ffmpeg, ffprobe AND the sharp/libvips image lane (dist/image-lane.js) — runs as
# uid 1001 with an empty environment (src/sandbox/exec.ts), so a decoder RCE can read neither the Node
# process's /proc/<pid>/environ nor its descriptors.
#
# The uid switch is done by /usr/bin/setpriv (util-linux, installed below), NOT by spawn's uid/gid: this
# process must hold ambient CAP_SETUID/CAP_SETGID to change a child's uid at all, and ambient caps
# survive execve — a plain uid-1000-to-1001 spawn would leave CAP_SETUID in the decoder, which could then
# setuid() back to `node`. setpriv switches, then clears the ambient + inheritable sets and sets
# no_new_privs before exec'ing, so the decoder has no capabilities at all. The container therefore starts
# as root ONLY to run docker-entrypoint.sh, which setpriv's to `node` keeping exactly those two caps
# ambient. compose supplies `cap_drop: ALL` + `cap_add: [SETUID, SETGID]`, `no-new-privileges`, a
# read-only rootfs and a noexec tmpfs /tmp. The boot preflight proves all of it (src/sandbox/preflight.ts).
#
# Stages:
#   base    pinned Node 22 (bookworm-slim, glibc) + corepack-pinned pnpm.
#   ffmpeg  download + checksum-verify the pinned FFmpeg release; keep only ffmpeg + ffprobe.
#   build   install the FULL workspace, build shared -> api(src is inlined) -> worker, then
#           `pnpm deploy --prod` the worker into a self-contained, dev-pruned /out.
#   runtime copy /out + the pinned binaries, provision the sandbox user, drop privileges in the
#           entrypoint, run the worker. (No port / no HTTP healthcheck: the worker is a queue consumer;
#           liveness is observed via pg-boss + logs. Docker restarts it on exit.)

# ----------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ----------------------------------------------------------------------------------------------------
FROM base AS ffmpeg
ARG FFMPEG_VERSION=n8.1.2
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-02-13-13/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-lgpl-8.1.tar.xz
ARG FFMPEG_SHA256=00eb62aac60b796fd2b0cc53c49574f58a1586cb1ab46744fc863c4c79565378
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/ffmpeg.tar.xz "$FFMPEG_URL" \
 && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/ffmpeg/bin \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg/bin --strip-components=2 \
      --wildcards '*/bin/ffmpeg' '*/bin/ffprobe' \
 && rm -f /tmp/ffmpeg.tar.xz \
 && chmod 0755 /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe \
 && /opt/ffmpeg/bin/ffprobe -version | head -n 1 | grep -q "$FFMPEG_VERSION" \
 && /opt/ffmpeg/bin/ffmpeg -version | head -n 1 | grep -q "$FFMPEG_VERSION"

# ----------------------------------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build shared -> api -> worker (the worker bundle inlines the api/shared sources). The trailing `...`
# selects the worker AND its workspace dependencies, built in order.
RUN pnpm --filter @civfix/media-worker... build
# Production-pruned, self-contained deployment of just the worker at /out. The native/external deps
# (sharp, ...) are installed here for linux-x64 and carried into runtime. ffmpeg-static/ffprobe-static
# are devDependencies and are pruned out on purpose (H8): the runtime ffmpeg is the pinned, checksummed
# one from the `ffmpeg` stage.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @civfix/media-worker --prod deploy /out

# ----------------------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 mediatools \
 && useradd --system --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin mediatools \
 && usermod --append --groups mediatools node \
 && command -v setpriv >/dev/null \
 && command -v cat >/dev/null
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=build --chown=node:node /out /app
COPY services/media-worker/docker-entrypoint.sh /usr/local/bin/media-worker-entrypoint
RUN chmod 0755 /usr/local/bin/media-worker-entrypoint
ENV FFMPEG_PATH=/usr/local/bin/ffmpeg \
    FFPROBE_PATH=/usr/local/bin/ffprobe \
    MEDIA_SANDBOX_UID=1001 \
    MEDIA_SANDBOX_GID=1001
# No USER: the entrypoint starts as root only to drop to `node` with ambient CAP_SETUID/CAP_SETGID (see
# the header + docker-entrypoint.sh); the worker itself refuses to boot as root (src/sandbox/preflight.ts).
# No EXPOSE / HEALTHCHECK: the worker opens no socket. It consumes the Jobs queue and exits non-zero on
# fatal error, so `restart: unless-stopped` in compose recovers it. main.js installs SIGTERM/SIGINT
# graceful shutdown (drain the queue, then tear down the DB pool + telemetry).
ENTRYPOINT ["/usr/local/bin/media-worker-entrypoint"]
CMD ["node", "dist/main.js"]
