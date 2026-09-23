# Media pipeline: served keys, decoder sandbox, egress

**Audience:** internal (engineering + ops). Not served publicly.
**Last updated:** 2026-09-02 (audit C1 / H7 / H8 / H13 / H16).

This page covers the four things about the media pipeline an operator has to
know: which object is actually served, what the decoders can reach, where
ffmpeg comes from, and how the worker talks to R2.

---

## 1. `served_key`: the object clients are pointed at (C1)

`media_assets` has two key columns:

| column | written by | who can write the OBJECT |
| --- | --- | --- |
| `r2_key` | the API at presign time (`uploads/YYYY/MM/<uploadId>`) | the **uploader**, via the presigned PUT, for its whole 15-minute TTL |
| `served_key` | the **media-worker**, in the CAS to a terminal status (`processed/uploads/YYYY/MM/<uploadId>`) | nobody outside the worker |

The worker downloads the upload object, runs every check (magic bytes, decode
guard, EXIF/GPS strip, NSFW seam, codec allowlist, remux), publishes the
processed bytes to `served_key`, records it in the same patch that flips the
row to `ready`/`held`, and then deletes the upload object (best-effort, with
the same tombstone + retry as every other reap).

**Every read path serves `served_key` and treats a NULL as "not found"** — the
same 404 as a non-ready asset (`services/media-served-key.ts` holds the one SQL
fragment; `getMedia` holds the TypeScript twin). Serving `r2_key` would mean
serving an object the uploader can still overwrite with unchecked bytes after
the asset is already published on a report.

The worker also binds the row to the exact object version it inspected: the API
records the upload's ETag at finalize and passes it in the job payload, the
worker compares it to what it downloaded, and it re-HEADs the upload key
immediately before publishing. A mismatch (or a vanished object) is a
`rejected` outcome — never a throw, per the pipeline's never-throw invariant.

### Deploy step: the served-key backfill (REQUIRED, once)

Rows that went `ready` **before** migration 0097 have `served_key = NULL`, and
their processed bytes live at `r2_key` (that is what the old worker wrote). Until
the backfill runs they read as not-found.

```sh
ssh civfix
sudo -n docker exec $(sudo docker ps --format '{{.Names}}' | grep -m1 -E 'compose-api-(blue|green)') node dist/db/backfill-served-key.js
```

Ordering, and it matters:

1. `0097` (adds the column) and `0098` apply with the rest of the migrations.
2. The new API + worker images start.
3. **Then** run the backfill above. It stamps `served_key = r2_key` for every
   pre-existing `ready` row **older than the 15-minute presigned-PUT window**,
   keyset-paged, idempotent, safe to run while the API serves traffic.
4. Re-run it once more after ~20 minutes to adopt rows uploaded right before the
   cutover (they are skipped on purpose while their PUT could still be live).

Between step 2 and step 3 pre-existing media reads as not-found. Prod is
pre-launch, so the window is acceptable; run the backfill immediately after the
health gate. Local dev: `pnpm --filter @civfix/api db:backfill:served-key`.

**Automate this before launch.** The deploy is CI-automatic on merge, but this
step is a human `docker exec`, so the not-found window lasts as long as it takes
someone to notice. The clean home for it is the compose `migrate` one-shot, which
already runs `node dist/db/migrate.js` before the API starts: appending
`&& node dist/db/backfill-served-key.js` there makes the deploy self-healing (the
backfill is idempotent and a no-op once every row is stamped). That file lives in
`civfix-infra`, so it is raised as a cross-slice request rather than changed here.

`R2_PUBLIC_BASE` note: the served key is new and is written exactly once, by the
worker, so no CDN edge can hold a pre-strip copy of it. The old failure mode (a
public fetch of the upload key caching the EXIF-laden original at the URL clients
later read) is structurally gone.

### Out-of-band index

`0098` also warns about `media_assets_orphan_sweep_idx`; build it per
`docs/out-of-band-indexes.md`.

---

## 2. The decoder sandbox (H7)

`ffmpeg`/`ffprobe`/`libvips` parse attacker-controlled bytes; the Node process holds `DATABASE_URL`, the
R2 keys and the Turnstile secret. **Every** untrusted decode runs in a separate process, as a separate
user, with no capabilities and no environment:

| lane | what runs | where |
| --- | --- | --- |
| video probe / remux / poster frame | `ffprobe`, `ffmpeg` | child, uid 1001 |
| images + video poster post-processing + perceptual hash | `node dist/image-lane.js` (sharp/libvips) | child, uid 1001 |

- **Empty environment.** Children get `extendEnv: false` and only `PATH` (the binary's own directory),
  `HOME`/`TMPDIR` (the per-job scratch dir) and `LANG=C`. They used to inherit the worker's entire
  environment.
- **A different uid, and NO capabilities.** The image provisions `mediatools` (uid/gid **1001**) and puts
  `node` in its group; `MEDIA_SANDBOX_UID`/`MEDIA_SANDBOX_GID` (**required in production**) name it.
  The switch goes through `setpriv`, never through `spawn`'s `uid`/`gid`:

  ```
  /usr/bin/setpriv --reuid=1001 --regid=1001 --clear-groups \
      --inh-caps=-all --ambient-caps=-all --no-new-privs -- <binary> …
  ```

  This is load-bearing, not decoration. The worker process must hold ambient `CAP_SETUID`/`CAP_SETGID`
  to change a child's uid at all, and **ambient capabilities survive both fork and execve** — so a plain
  `uid: 1001` spawn handed ffmpeg `CAP_SETUID`, and a decoder RCE could `setuid(1000)` straight back to
  `node` and read `/proc/<pid>/environ` (a 1000→1001 change clears nothing; the kernel only clears
  capabilities when leaving uid 0, and `no-new-privileges` does not touch the ambient set). `setpriv`
  performs the switch with the capabilities it inherits and then clears the ambient and inheritable sets
  and sets `no_new_privs` before `execve`, so the decoder starts with **CapAmb = CapPrm = CapEff = CapInh
  = 0** and can never return to the credentialed uid.
- **Getting the two capabilities to Node in the first place.** `docker-entrypoint.sh` runs as root only
  long enough to `setpriv --reuid=node --regid=node --init-groups --inh-caps=-all,+setuid,+setgid
  --ambient-caps=+setuid,+setgid`. No securebit is set and none is needed: setpriv calls
  `prctl(PR_SET_KEEPCAPS, 1)` before `setresuid` and re-applies the effective set afterwards, so the
  permitted set survives the root→node drop and the ambient raise (which needs the capability in both
  permitted and inheritable) succeeds. `--securebits=…` would in fact BREAK the container:
  `PR_SET_SECUREBITS` requires `CAP_SETPCAP`, which this container is not granted, so setpriv would exit
  EPERM and the worker would crash-loop while `/readyz` (the API's) stayed green.
- **The bounding set.** `--bounding-set=-all` is deliberately NOT passed (in the entrypoint or the
  decoder wrapper): `PR_CAPBSET_DROP` needs `CAP_SETPCAP` for the same reason, so requesting it would
  fail the entrypoint and every decode. It is inert anyway — with `no_new_privs` and an empty
  inheritable/ambient set, a non-empty bounding set grants a child nothing (file capabilities and setuid
  bits cannot elevate). If `SETPCAP` is ever added to `cap_add`, set `MEDIA_SANDBOX_DROP_BOUNDING=1` and
  the flag is passed and asserted as zero too.
- **The child is untrusted output, not just untrusted input.** The image lane returns a JSON envelope,
  and the parent holds the credentials, so the parent accepts no paths, names or content types from it:
  it reads two FIXED file names inside the scratch dir it created (each must be a regular file — not a
  symlink — owned by the sandbox uid) and validates every scalar against the worker's own limits and
  allowlists before anything reaches a storage PUT or a DB row. Without that, a compromised child could
  name `../../proc/self/environ` as its output and have the parent publish `DATABASE_URL` and the R2
  keys to the public bucket.
- **A decoder that will not START is an infra fault; one that DIES is a verdict.** `SandboxSpawnError`
  (missing entry, unreadable `node_modules`, setpriv EPERM — "no process ever ran") propagates out of
  the pipeline and becomes `MediaInfraError`, so the job retries. It is the second deliberate throwable
  in the worker, alongside `MediaInfraError` itself. "Never ran" is proven by the absence of a pid (or a
  failing `spawn` syscall), NOT by an errno allowlist: `EAGAIN` from the pids limit — exactly what a fork
  bomb produces — `EMFILE` and `ENOMEM` are transient infra conditions, and rejecting on them would
  delete a resident's upload because the container briefly ran out of process slots. Everything else is
  a verdict on the bytes and is
  `rejected`: a non-zero exit, a timeout, an over-large output, and — the distinction that matters —
  **death by signal**. execa reports `exitCode: undefined` for both "never spawned" and "killed by a
  signal", so a SIGSEGV/SIGABRT from a malformed file, or the cgroup OOM killer's SIGKILL on a decode
  bomb, would otherwise be retried ~36 times over five hours, re-crashing a decoder each attempt. The
  signal name is recorded in the rejection note.
- **Scratch dirs are group-shared, and uid 1001 is a SHARED trust domain.** Each job's `mkdtemp` dir is
  `chgrp`ed to the sandbox group and `chmod 2770` (setgid, so decoder outputs inherit the group); the
  staged input is `0660` and the entrypoint's `umask 0007` keeps outputs group-readable. Node stays the
  directory owner, which is what lets it unlink the child's files and remove the dir.

  Every decoder of every concurrent job runs as the SAME uid 1001, and a compromised child can fork a
  survivor, so "the child is dead" is not a safety argument — a sibling or a survivor can `rename()`
  inside another job's scratch dir. Three things close that:
    1. **The dir is sealed before the parent looks at it.** Once the child exits, Node (the owner)
       `chmod 0700`s the dir, so no uid-1001 process can rename anything into it any more.
    2. **Outputs are opened once, never re-resolved.** `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`, then the
       checks (`isFile`, owner is the sandbox uid, `nlink === 1`) and the read run against THAT handle.
       `lstat`-then-`readFile` was a real race: a symlink swapped in between made the credentialed
       parent read `/proc/self/environ` — `DATABASE_URL` and the R2 keys — and publish it as the
       asset's bytes. `O_NOFOLLOW` fails a symlink with ELOOP and `O_NONBLOCK` refuses to block on a
       FIFO. The same read path is used for the video lane's remux and poster outputs.
    3. **Survivors are killed, and killed EARLY.** Each decoder is spawned in its own process group
       (`detached`), and the group is SIGKILLed the moment the leader exits and again on a timer at the
       tool's own `timeoutMs` — both BEFORE the parent waits for the stdio drain. That ordering is the
       whole point: execa does not settle until every pipe reaches EOF, so a grandchild that inherited
       fd 1/2 used to keep the call pending for as long as it lived (a 500 ms budget measured settling
       after 30 s), which voided every per-tool timeout and let an exploit's forks pile up while the job
       burned its 90 s wall clock. A `finally` group-kill remains as a backstop, and the worker
       group-kills anything still in flight on process exit (`detached` turns off execa's own
       parent-exit cleanup).

  A decoder's stdout is capped per call (`MEDIA_MAX_TOOL_STDOUT_BYTES`, 1 MiB): every lane either prints
  a small JSON/text result or writes its real output to a file in the scratch dir, so the parent never
  buffers the media budget on a lane's say-so. Overflow is a verdict on the bytes, not an infra fault.

  The worker process is PID 1 in its container, and PID 1 does not reap orphans unless it is an init:
  the compose service therefore runs with `init: true`, so group-killed decoders and any survivor they
  left behind are reaped instead of accumulating as zombies against `pids_limit`.
- **Boot self-check (`src/sandbox/preflight.ts`).** In production the worker asserts it is not root,
  resolves both binaries, hands over one scratch dir, runs the REAL image lane on a built-in 1×1 PNG and
  the pinned ffprobe through the wrapper (so a missing `dist/image-lane.js`, a `node_modules` the sandbox
  uid cannot read, or a broken protocol refuses the boot instead of rejecting every upload), and — this
  is the part that matters — spawns
  `cat /proc/self/status` **through the real wrapper** and requires the child to report
  `Uid: 1001 1001 1001 1001`, `Gid: 1001 1001 1001 1001` and `CapInh/CapPrm/CapEff/CapAmb` all zero
  (`CapBnd` must not exceed the container's own `{CAP_SETUID, CAP_SETGID}`). An `id -u` check would have
  passed in exactly the broken state described above, so it is not used. Any failure refuses the boot
  instead of turning every upload into "rejected".

The preflight (its lane checks included) runs only when `NODE_ENV=production`; the lane-entry existence
check also runs whenever a sandbox identity is configured, so a wrong `MEDIA_IMAGE_LANE_ENTRY` fails at
boot rather than rejecting every photo. Local dev on macOS (`dev/run.sh worker`) sets neither, so it
takes the in-process path and never touches `setpriv`.

`dist/preflight-only.js` runs exactly that check and nothing else (no DB, Redis or R2), and backend CI
runs it inside the built image under the production capability set, so the entrypoint/setpriv/uid
contract is proven on every build rather than at deploy time.

When a real NSFW model is vendored, it must score INSIDE the child (or in a second sandboxed call over
the child's stripped output) — never in the parent. Decoding or running a model in the credentialed
process would re-open exactly the hole this section closes.

Never place an executable in `/tmp`: the compose tmpfs is `noexec`.

## 3. Where ffmpeg comes from (H8)

`ffprobe-static@3.1.0` ships an FFmpeg **4.0.2 (2018)** binary — the tool that
must interpret an untrusted container — with no security-patch channel. It is a
**devDependency** now and is pruned out of the production image.

The image installs a pinned, checksum-verified release instead
(`FFMPEG_URL` / `FFMPEG_SHA256` ARGs in `services/media-worker/Dockerfile`,
currently **FFmpeg n8.1.2**, LGPL linux64 static). The build fails on a checksum
mismatch and runs `ffprobe -version` as a sanity step. `FFMPEG_PATH` /
`FFPROBE_PATH` are set in the image and **required in production**
(`src/sandbox/binaries.ts`), so there is no silent fallback to the 2018 build;
outside production the npm statics remain the fallback so local dev and the unit
suite need no setup.

Bumping: pick a newer asset from the same feed, set `FFMPEG_URL`, and set
`FFMPEG_SHA256` to `sha256sum` of the downloaded file. The build breaks loudly if
the pinned URL is pruned upstream.

The probe is also narrowed: `-f mov,mp4,m4a,3gp,3g2,mj2` forces the demuxer
family intake accepts (container auto-detection was the widest parser surface),
and `-analyzeduration`/`-probesize` are cut to 2s/5MB.

---

## 4. Video size caps (H16)

Before any remux or frame decode, a video is rejected when its resolution
exceeds `MEDIA_VIDEO_MAX_PIXELS` (default 3840x2160), its frame rate exceeds
`MEDIA_VIDEO_MAX_FPS` (120), its bitrate exceeds `MEDIA_VIDEO_MAX_BITRATE`
(50 Mbps), or ffprobe reports no usable resolution. The frame grab additionally
runs with `-max_pixels` and `-threads 1`. All of these are `rejected` outcomes,
never throws.

---

## 5. Egress: the worker reaches R2 through a proxy

The worker sits on an `internal: true` compose network with no internet route.
Its only way out is the CONNECT proxy in `HTTPS_PROXY`
(`http://media-egress-proxy:8888`), with `NO_PROXY` covering the in-network
hosts. Neither the AWS SDK nor Node's `fetch` reads those variables, so:

- `adapters/storage.r2.ts` builds the `S3Client` with a `NodeHttpHandler` whose
  https agent is an `HttpsProxyAgent` when `HTTPS_PROXY` is set and the target
  host is not in `NO_PROXY` (a CONNECT tunnel is transparent to SigV4).
- `media-worker/src/download.ts` fetches the presigned GET through undici's
  `EnvHttpProxyAgent` dispatcher under the same condition.

Both are exact no-ops when `HTTPS_PROXY` is unset — the API container, local dev,
tests and the `dev/` stack are unchanged.

`@sentry/node` (GlitchTip) reads only the **lowercase** `https_proxy`/`no_proxy`, so the worker's
compose environment must set both cases if a `GLITCHTIP_DSN` is ever configured for it — and the DSN's
host must be added to the allowlist, or error reports fail silently. The worker has no DSN today.

**A new outbound host the worker acquires must be added to
`civfix-infra/egress/allowed-hosts`,** or the proxy refuses the CONNECT and the
call fails closed.

---

## 6. The delayed upload reap (`media.upload.reap`)

The worker deletes the upload object as soon as it publishes to `served_key`, but the client's presigned
PUT for that key stays valid for its full 15-minute TTL. A re-PUT inside the window used to recreate the
object *after* the only delete that would ever happen — the row is bound and terminal by then, so the
orphan sweep (unbound rows only) never matches it and the rejected-media cleanup never runs again. With
`R2_PUBLIC_BASE` set, that is a permanent, unvetted object at a URL the uploader knows.

So every terminal `media.checks` outcome (and the stuck sweep's give-up path) enqueues
`media.upload.reap` with `startAfter = R2_PUT_TTL_SEC + 5 min`, `singletonKey: uploadId`. The job deletes
`r2_key` only when nothing serves it: the row is gone, or it is `rejected`, or its `served_key` is set
and differs from `r2_key`. A `validating` row, a legacy row whose `served_key` **is** `r2_key`
(pre-0097 backfill shape), and a key another row still references are all left alone. A failed delete is
tombstoned and retried by the orphan sweep's leak lane. The queue is created only by the worker, with an
explicit `short` policy — the API never enqueues it.
