#!/bin/sh
# Drop from root to `node`, keeping ONLY ambient CAP_SETUID/CAP_SETGID so the worker can spawn ffmpeg,
# ffprobe and the image lane as the credential-less sandbox user (uid 1001). Those two capabilities are
# exactly what the decoders' own setpriv wrapper CLEARS before exec'ing them (src/sandbox/exec.ts), so no
# untrusted parser ever holds one. umask 0007 keeps decoder outputs group-readable inside the per-job
# scratch dir (mode 2770) and readable by nobody else.
#
# No --securebits and no --bounding-set: both prctls require CAP_SETPCAP, which this container is not
# granted (cap_drop: ALL + cap_add: [SETUID, SETGID]), so either flag would EPERM here and crash-loop the
# worker. Neither is needed. setpriv calls prctl(PR_SET_KEEPCAPS, 1) before setresuid and re-applies the
# effective set afterwards, so the permitted set survives the root->node drop and the ambient raise below
# (which needs the capability in both permitted and inheritable) succeeds. The bounding set is already
# exactly {SETUID, SETGID} because of that same compose config, and a residual bounding set grants a
# child nothing once its ambient and inheritable sets are empty and no_new_privs is set.
set -eu
umask 0007
exec setpriv \
  --reuid=node \
  --regid=node \
  --init-groups \
  --inh-caps=-all,+setuid,+setgid \
  --ambient-caps=+setuid,+setgid \
  "$@"
