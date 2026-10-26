# syntax=docker/dockerfile:1.7
#
# civfix city filer image (epic civfix/issue-tracker#164, D7). BUILD CONTEXT IS THE REPO ROOT:
#     docker build -f services/city-filer/Dockerfile -t civfix/city-filer:latest .
#
# Built like the media worker's: tsup inlines @civfix/api, @civfix/seams and @civfix/contract, and
# `pnpm deploy --prod` carries the external dependencies (playwright-core among them) into /app.
#
# TWO USERS. `node` runs the wrapper and holds DATABASE_URL, the R2 keys and the queue. Every portal
# script, Chromium and git run as `filer` (uid/gid 1001, no credentials) through /usr/local/bin/filer-shell,
# which empties the environment and setpriv's to filer with no capabilities. So the container starts as
# root only to run the entrypoint, which drops to node keeping ambient CAP_SETUID/CAP_SETGID for
# filer-shell, as the media worker does; compose grants exactly those two (cap_drop: ALL). The workspace
# layout below is the only place modes are set: the entrypoint has no CHOWN or DAC_OVERRIDE to fix them.
#
# /workspace (a named volume, copied from here on first mount):
#   /workspace            node:filer 0755  filer can create, rename or swap nothing at the top level
#   runs/                 node:filer 0750  the wrapper's run directories, read-only to filer
#   portals/              filer      2770  the scripts filer writes for itself (D8)
#   .git/                 filer      2770  their history; the repo is filer's, git runs only as filer
#   proved/               node:node  0755  each host's proved script sha256; filer reads, never writes
#   .gitignore            node       0644  runs/, proved/ and node_modules/ stay out of that history
#   node_modules/@civfix/filer-kit -> /app/kit   node's link, the kit a script imports (ESM ignores NODE_PATH)
# dist/preflight.js checks all of it; #178's smoke runs it. /app/classify (node:node 0755) is classify's empty
# cwd: neither it nor a directory above it is writable by filer.
#
# CLAUDE CODE (D9) is installed here, never as a workspace dependency: the CLI and @playwright/mcp with
# npm -g, claude-swap as a uv tool on a uv-managed Python. Each is pinned below; a bump is an edit here plus
# a #178 smoke run. @playwright/mcp drives the Chromium the kit's playwright-core installed: the build
# fails unless both use the same playwright-core, so there is one browser in /ms-playwright.

ARG UV_VERSION=0.13.5

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @civfix/city-filer... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @civfix/city-filer --prod deploy /out

FROM base AS runtime
ARG SERVICE_VERSION=0.0.0
ARG CLAUDE_CODE_VERSION=2.1.310
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ARG CLAUDE_SWAP_VERSION=0.28.0
ENV NODE_ENV=production \
    SERVICE_VERSION=${SERVICE_VERSION} \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# Chromium comes from the deployed playwright-core's own CLI, so the browser is the one the kit's pin
# drives.
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux git ca-certificates \
 && /app/node_modules/.bin/playwright-core install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 filer \
 && useradd --system --uid 1001 --gid 1001 --home-dir /home/filer --create-home --shell /usr/sbin/nologin filer \
 && chmod 0700 /home/filer \
 && usermod --append --groups filer node \
 && command -v setpriv >/dev/null
COPY --from=uv /uv /usr/local/bin/uv
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --global --no-fund --no-audit \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && npm cache clean --force \
 && UV_PYTHON_PREFERENCE=only-managed UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin UV_CACHE_DIR=/tmp/uv-cache \
    uv tool install --python 3.12 claude-swap==${CLAUDE_SWAP_VERSION} \
 && rm -rf /tmp/uv-cache \
 && node -e ' \
      const { createRequire } = require("node:module"); \
      const core = (dir) => createRequire(dir + "/package.json")("playwright-core/package.json").version; \
      const mcp = core("/usr/local/lib/node_modules/@playwright/mcp"), kit = core("/app"); \
      if (mcp !== kit) { console.error("@playwright/mcp uses playwright-core " + mcp + ", the kit " + kit); process.exit(1) }'
COPY services/city-filer/managed-settings.json /etc/claude-code/managed-settings.json
COPY services/city-filer/gitconfig /etc/gitconfig
COPY services/city-filer/bin/filer-shell /usr/local/bin/filer-shell
COPY services/city-filer/docker-entrypoint.sh /usr/local/bin/city-filer-entrypoint
RUN chmod 0644 /etc/gitconfig /etc/claude-code/managed-settings.json \
 && chmod 0755 /usr/local/bin/filer-shell /usr/local/bin/city-filer-entrypoint \
 && install -d -o node -g filer -m 0755 /workspace \
 && install -d -o node -g filer -m 0750 /workspace/runs \
 && install -d -o filer -g filer -m 2770 /workspace/portals /workspace/.git \
 && install -d -o node -g node -m 0755 /workspace/proved /app/classify \
 && install -d -o node -g node -m 0755 /workspace/node_modules /workspace/node_modules/@civfix \
 && ln -s /app/kit /workspace/node_modules/@civfix/filer-kit \
 && chown -h node:node /workspace/node_modules/@civfix/filer-kit \
 && printf 'runs/\nproved/\nnode_modules/\n' > /workspace/.gitignore \
 && chown node:node /workspace/.gitignore \
 && chmod 0644 /workspace/.gitignore \
 && HOME=/home/filer setpriv --reuid=filer --regid=filer --clear-groups -- git -C /workspace init --quiet -b main \
 && HOME=/home/filer setpriv --reuid=filer --regid=filer --clear-groups -- git -C /workspace commit --quiet --allow-empty -m "workspace"
# No USER: the entrypoint drops to node itself. No EXPOSE or HEALTHCHECK: the filer only works the queue.
ENTRYPOINT ["/usr/local/bin/city-filer-entrypoint"]
CMD ["node", "dist/main.js"]
