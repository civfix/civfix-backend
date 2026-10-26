#!/bin/sh
# Drop from root to `node`, keeping only ambient CAP_SETUID/CAP_SETGID, which filer-shell needs to start
# filer processes as `filer` and then clears for them. The same drop as the media worker's
# (services/media-worker/docker-entrypoint.sh, which explains why there is no --securebits or
# --bounding-set). No file setup: the container has no CHOWN or DAC_OVERRIDE, and the Dockerfile set
# every mode.
set -eu
umask 0007
exec setpriv \
  --reuid=node \
  --regid=node \
  --init-groups \
  --inh-caps=-all,+setuid,+setgid \
  --ambient-caps=+setuid,+setgid \
  "$@"
