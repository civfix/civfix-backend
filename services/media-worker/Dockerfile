# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# civfix media-worker production image (multi-stage).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (civfix-backend/). The worker is a pnpm workspace package that
# (a) inlines @civfix/api + @civfix/seams (workspace source) + @civfix/contract (from the private registry repo.civfix.org)
# at BUILD time (tsup noExternal), and
# (b) keeps the native / heavy runtime deps EXTERNAL (sharp, execa, exifr, pg-boss, postgres,
# drizzle-orm, undici, @sentry/node, @aws-sdk/*). So the build needs the root
# manifests + lockfile + .npmrc + services/api/ (its source) in the context, and the runtime needs the
# external deps installed for THIS platform. Build by hand from the repo root:
#     docker build -f services/media-worker/Dockerfile -t civfix/media-worker:latest .
#
# FFMPEG / SHARP IN-CONTAINER (the key correctness point):
#   * FFMPEG IS BUILT HERE FROM THE OFFICIAL SOURCE RELEASE, not taken from npm or from a third-party
#     binary build. ffprobe-static@3.1.0 ships an FFmpeg 4.0.2 binary from 2018 (the tool that must
#     interpret untrusted container bytes) with no channel for the demuxer memory-safety fixes released
#     since. FFmpeg publishes no binaries of its own, and the dated third-party builds this stage used to
#     download are pruned after about two weeks, which broke every build that still pinned one. The
#     `ffmpeg` stage downloads the ffmpeg.org release tarball, checks it against FFMPEG_SHA256 AND
#     requires a signature by FFmpeg's release signing key, pinned by its fingerprint FFMPEG_KEY_FPR,
#     then compiles ONLY what src/sandbox uses: the mov demuxer, the mp4 + image2 muxers, the h264/hevc
#     decoders, the mjpeg encoder for the poster frame, the libx264 encoder and the scale + fps filters
#     for the served-video transcode, and the file protocol (configure adds the filters the ffmpeg CLI
#     inserts itself). No audio decoder or encoder: audio is only ever copied. Every other demuxer and
#     decoder, the IAMF audio parser the mov demuxer would otherwise pull in, the network stack and all
#     other external libraries are left out, so a hostile upload only reaches the mov demuxer (with its
#     ISO media and RIFF helpers) and the h264/hevc parsers and decoders. The runtime stage exports
#     FFMPEG_PATH/FFPROBE_PATH, which sandbox/binaries.ts REQUIRES in production (the npm static
#     packages are devDependencies and are pruned out of this image by `pnpm --prod deploy`, so there is
#     no silent fallback to the 2018 build), and the boot preflight pushes an h264 and an hevc clip
#     through the real video lane, so a build missing a component fails the CI smoke job.
#     BUMPING IT: set FFMPEG_VERSION to a newer release from https://ffmpeg.org/releases/, verify its
#     .asc against https://ffmpeg.org/ffmpeg-devel.asc (`gpg --verify`), and set FFMPEG_SHA256 to the
#     `sha256sum` of the tarball. A new sandbox feature that needs another format or codec adds it to
#     the configure line.
#   * LIBX264 is the H.264 encoder behind the served-video transcode (src/sandbox/ffmpeg-transcode.ts).
#     Licence: GPL-2.0-or-later, compatible with this repo's AGPL-3.0; it is linked statically into the
#     separate ffmpeg executable only (hence --enable-gpl), never into the Node process. VideoLAN
#     publishes no release tarballs, so X264_COMMIT pins a commit of the upstream `stable` branch and
#     X264_SHA256 pins GitLab's archive of it. It never sees uploaded bytes, only frames the h264/hevc
#     decoders produced. BUMPING IT: take the head of
#     https://code.videolan.org/videolan/x264/-/commits/stable, download
#     https://code.videolan.org/videolan/x264/-/archive/<commit>/x264-<commit>.tar.gz and set both ARGs.
#   * sharp 0.33.x ships prebuilt linux binaries (@img/sharp-linux-*) that run on glibc, which the
#     Debian bookworm base provides. No build toolchain or libvips apt package is required.
#   Both are installed INSIDE this linux image (never copied from the host), so the platform is correct.
#
# DECODER PRIVILEGE SEPARATION: the runtime stage provisions a SECOND, credential-less user
# (mediatools, uid/gid 1001) and puts `node` in its group. Node holds DATABASE_URL and the R2 keys; every
# untrusted-byte parser (ffmpeg, ffprobe AND the sharp/libvips image lane, dist/image-lane.js) runs as
# uid 1001 with an empty environment (src/sandbox/exec.ts), so a decoder RCE can read neither the Node
# process's /proc/<pid>/environ nor its descriptors.
#
# The uid switch is done by /usr/bin/setpriv (util-linux, installed below), NOT by spawn's uid/gid: this
# process must hold ambient CAP_SETUID/CAP_SETGID to change a child's uid at all, and ambient caps
# survive execve: a plain uid-1000-to-1001 spawn would leave CAP_SETUID in the decoder, which could then
# setuid() back to `node`. setpriv switches, then clears the ambient + inheritable sets and sets
# no_new_privs before exec'ing, so the decoder has no capabilities at all. The container therefore starts
# as root ONLY to run docker-entrypoint.sh, which setpriv's to `node` keeping exactly those two caps
# ambient. compose supplies `cap_drop: ALL` + `cap_add: [SETUID, SETGID]`, `no-new-privileges`, a
# read-only rootfs and a noexec tmpfs /tmp. The boot preflight proves all of it (src/sandbox/preflight.ts).
#
# Stages:
#   base    pinned Node 22 (bookworm-slim, glibc) with corepack enabled.
#   ffmpeg  verify the pinned FFmpeg source release and compile the minimal ffmpeg + ffprobe.
#   build   install the FULL workspace, build api(src is inlined) -> worker, then
#           `pnpm deploy --prod` the worker into a self-contained, dev-pruned /out.
#   runtime plain Node 22 with no package manager: copy /out + the pinned binaries, provision the
#           sandbox user, drop privileges in the entrypoint, run the worker. (No port / no HTTP
#           healthcheck: the worker is a queue consumer; liveness is observed via pg-boss + logs.
#           Docker restarts it on exit.)

# The digest is the multi-arch index (it carries linux/arm64 and linux/amd64), so a rebuild of the same
# commit gets the same base; the tag only tells a reader which line it is. Move both together.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true
RUN corepack enable
WORKDIR /app

FROM base AS ffmpeg
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
ARG FFMPEG_KEY_FPR=FCF986EA15E6E293A5644F10B4322F04D67658D8
ARG X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
ARG X264_SHA256=cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils gpg gpgv gcc libc6-dev make nasm pkgconf \
 && rm -rf /var/lib/apt/lists/*
# 8-bit 4:2:0 only: the transcode always outputs yuv420p, so the other bit depths and chroma formats
# would be dead code in the binary.
WORKDIR /tmp/x264
RUN curl -fsSL --retry 5 --retry-all-errors -o x264.tar.gz "https://code.videolan.org/videolan/x264/-/archive/${X264_COMMIT}/x264-${X264_COMMIT}.tar.gz" \
 && echo "${X264_SHA256}  x264.tar.gz" | sha256sum -c - \
 && tar -xzf x264.tar.gz --strip-components=1 \
 && ./configure \
      --prefix=/opt/x264 \
      --enable-static \
      --enable-pic \
      --disable-cli \
      --disable-opencl \
      --bit-depth=8 \
      --chroma-format=420 \
      --extra-cflags=-fstack-protector-strong \
 && make -j"$(nproc)" \
 && make install
WORKDIR /tmp/ffmpeg
# --toolchain=hardened: stack protector, FORTIFY_SOURCE, full RELRO and PIE for the one binary that
# parses attacker-supplied bytes.
RUN curl -fsSL --retry 5 --retry-all-errors -O "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && curl -fsSL --retry 5 --retry-all-errors -O "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" \
 && echo "${FFMPEG_SHA256}  ffmpeg-${FFMPEG_VERSION}.tar.xz" | sha256sum -c - \
 && curl -fsSL --retry 5 --retry-all-errors -o ffmpeg-devel.asc https://ffmpeg.org/ffmpeg-devel.asc \
 && gpg --batch --yes --dearmor -o ffmpeg-devel.gpg ffmpeg-devel.asc \
 && gpgv --keyring ./ffmpeg-devel.gpg --status-fd 1 "ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
      | grep -q "^\[GNUPG:\] VALIDSIG .* ${FFMPEG_KEY_FPR}\$" \
 && tar -xJf "ffmpeg-${FFMPEG_VERSION}.tar.xz" --strip-components=1 \
 && PKG_CONFIG_PATH=/opt/x264/lib/pkgconfig ./configure \
      --toolchain=hardened \
      --pkg-config-flags=--static \
      --disable-everything \
      --disable-autodetect \
      --disable-network \
      --disable-avdevice \
      --disable-doc \
      --disable-debug \
      --disable-ffplay \
      --disable-iamf \
      --enable-protocol=file \
      --enable-demuxer=mov \
      --enable-muxer=mp4,image2 \
      --enable-decoder=h264,hevc \
      --enable-parser=h264,hevc \
      --enable-encoder=mjpeg,libx264 \
      --enable-filter=scale,fps \
      --enable-gpl \
      --enable-libx264 \
 && make -j"$(nproc)" \
 && install -D -m 0755 -t /opt/ffmpeg/bin ffmpeg ffprobe \
 && /opt/ffmpeg/bin/ffprobe -version | head -n 1 | grep -q "version ${FFMPEG_VERSION} " \
 && /opt/ffmpeg/bin/ffmpeg -version | head -n 1 | grep -q "version ${FFMPEG_VERSION} "

FROM base AS build
# pnpm comes from the root package.json packageManager field, sha512 included, so the image runs exactly the
# pnpm CI and developers run. Copied alone first so the download stays cached until the root package.json changes.
COPY package.json ./
RUN corepack install
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build api -> worker (the worker bundle inlines the api, seams and contract sources). The trailing `...`
# selects the worker AND its workspace dependencies, built in order.
RUN pnpm --filter @civfix/media-worker... build
# Production-pruned, self-contained deployment of just the worker at /out. The native/external deps
# (sharp, ...) are installed here for the target platform and carried into runtime.
# ffmpeg-static/ffprobe-static are devDependencies and are pruned out on purpose: the runtime ffmpeg
# is the pinned, checksummed one from the `ffmpeg` stage.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @civfix/media-worker --prod deploy /out

# From the plain Node image, not `base`: the runtime needs no package manager, and corepack and the pnpm it
# installs carry their own bundled dependency trees (tar, glob, minimatch, cross-spawn, ...) that the image
# scan flags. Same digest as `base`, so both move together.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
# Same contract as the api image: the release identity is a property of the promoted artifact, not of the
# deploy that placed it. Read by src/seams.ts as the GlitchTip `release`.
ARG SERVICE_VERSION=0.0.0
ENV NODE_ENV=production \
    SERVICE_VERSION=${SERVICE_VERSION}
WORKDIR /app
# No package manager, as in the api image: nothing here runs one, and npm's bundled dependency tree is
# where the image scan finds fixable HIGH advisories.
RUN rm -rf /usr/local/bin/corepack /usr/local/lib/node_modules/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/lib/node_modules/npm
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 mediatools \
 && useradd --system --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin mediatools \
 && usermod --append --groups mediatools node \
 && command -v setpriv >/dev/null \
 && command -v nice >/dev/null \
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
CMD ["node", "--enable-source-maps", "dist/main.js"]
