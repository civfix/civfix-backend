# City filing: the city filer

The city filer (`services/city-filer`, image `ghcr.io/civfix/city-filer`) files reports through city
web portals. It runs on the prod box only (epic civfix/issue-tracker#164, D10). The API owns every
filing record: it enqueues `filing.run`, and the filer reports each attempt back on `filing.result`,
which the API applies (status, timeline, push and evidence rows in one transaction).

## One attempt

The wrapper works `filing.run` one job at a time:

1. While filing is paused the job completes and the filing stays `queued`.
2. `claimFiling` moves the filing from `queued` to `running` for that attempt and gives it a new run
   id; a job whose attempt is stale completes without running.
3. A report that is no longer fileable (rejected, deleted or verdict-rejected) ends `cancelled`.
4. The wrapper creates `runs/<filingId>-<runId>/` (never one that exists) with `packet.json`, the
   report's photos (images of 10 MB or less, at most five) and an empty `out/`.
5. `portals/<host>/script.mjs` runs live as `filer`, with a 5-minute timeout. With no script the
   filing waits as "Claude unavailable" until Claude Code writes one (#177).
6. `out/result.json` is checked, the screenshots it lists and a copy of the script are uploaded to R2
   under `filings/<filingId>/`, and the outcome goes back on `filing.result`.

At boot, before the queue, every filing still `running` gets a failed result: `uncertain_submission`
when its current run left the submit marker (`out/.submit-clicked`, written just before the live
submit click), else `portal_error`. Run directories over 30 days old are deleted at boot and daily;
the R2 evidence is the record.

`packet.json` holds the ticket text, the location, the category, the route's request-type hint, the
portal's start URL, CivFix's own contact block and `dryRun`. Nothing about the resident is in it.

## Two users and filer-shell

`node` runs the wrapper and holds `DATABASE_URL`, the R2 keys and the queue. Everything a portal
script can steer (the script, Chromium, git, and later Claude Code) runs as `filer` (uid 1001), which
holds no credential. The only way in is `/usr/local/bin/filer-shell [--run-dir <dir> --host <host>] <cmd>`:
it empties the environment (`env -i`) down to `HOME`, `PATH`, `PLAYWRIGHT_BROWSERS_PATH` and
`TMPDIR`, plus `FILER_RUN_DIR` and `FILER_HOST` for a run, and `setpriv`s to `filer` with no groups,
no capabilities and `no_new_privs`. The wrapper spawns it in a process group of its own and kills the
group when the run ends or times out, so nothing a script starts outlives its run.

The entrypoint drops from root to `node` keeping ambient `CAP_SETUID`/`CAP_SETGID`, the two
capabilities compose grants, which filer-shell spends and clears. It does no file setup; the
Dockerfile sets every mode. `dist/preflight.js` proves the drop, filer-shell's environment, Chromium
as `filer` and the workspace permissions below.

## /workspace

A named volume, copied from the image on first mount:

| Path | Owner, mode | Why |
| --- | --- | --- |
| `/workspace` | `node:filer` 0755 | `filer` can create, rename or swap nothing at the top level, so no `CLAUDE.md` or fake `runs/` can appear there |
| `runs/` | `node:filer` 0750 | run directories are the wrapper's; `filer` can read them but not rename, replace or add one |
| `runs/<id>-<runId>/`, `packet.json`, `photos/` | `node:filer` 0750 / 0640 | `filer` reads the packet and photos and cannot change them |
| `runs/<id>-<runId>/out/` | `node:filer` 2770 | the one place a run writes; setgid keeps its files in the group `node` deletes from |
| `portals/` | `filer` 2770 | the scripts and notes `filer` writes for itself |
| `.git/` | `filer` 2770 | their history; git runs only as `filer` |
| `.gitignore` | `node` 0644 | keeps `runs/` and `node_modules/` out of the history |
| `node_modules/@civfix/filer-kit` | `node`, link to `/app/kit` | the kit a script imports (ESM ignores `NODE_PATH`) |

The wrapper reads anything `filer` wrote (the script, `result.json`, screenshots) without trusting
it: no symlinks, no FIFOs, regular files only, size-capped, and only a file that sits directly in its
own directory.

## Environment

The filer's own SOPS dotenv (#179):

| Variable | |
| --- | --- |
| `FILER_DRY_RUN` | default false; while true every run stops before the submit and ends `needs_human` / `dry_run`, with its evidence |
| `FILING_CONTACT_FIRST_NAME`, `FILING_CONTACT_LAST_NAME`, `FILING_CONTACT_EMAIL` | required; the contact every portal gets (D2) |
| `FILING_CONTACT_PHONE` | optional |
| `DATABASE_URL` | the API's database (filings and the pg-boss queue) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | the media bucket, where evidence goes |
| `GLITCHTIP_DSN` | optional error reporting |

## Inspecting the scripts on the box

The workspace repository is `filer`'s, so read it through filer-shell:

```sh
docker exec -it compose-city-filer-1 filer-shell git -C /workspace log --stat
docker exec -it compose-city-filer-1 filer-shell cat /workspace/portals/<host>/script.mjs
```

Each filing also records its `script_version` (the first 12 hex characters of the script's sha256),
and the exact script that ran is in R2 with its evidence.
