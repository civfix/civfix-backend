# Image scan runbook

What to do when the Trivy scan of a backend image fails. A new advisory can turn the scan red with no change
on our side, so read this against the failing job's output, find the origin of each finding in the table,
and apply that row's fix.

## What the gate checks and where it runs

Trivy fails the run on any HIGH or CRITICAL vulnerability that has a fixed version. Findings with no fix
yet (Trivy status `affected`, `will_not_fix`, `fix_deferred`, `end_of_life`) are skipped, so they never
block.

- `trivy.yaml` (repo root) is the gate: `severity: [HIGH, CRITICAL]`, `ignore-unfixed: true`,
  `exit-code: 1`. Trivy loads it from the directory it runs in (`Loaded file_path="trivy.yaml"` in the log),
  and the same way loads a `.trivyignore` there if one exists.
- `.github/actions/setup-trivy/action.yml` installs the pinned Trivy (0.76.1).
- **On every PR**, `.github/workflows/ci.yml`, job `media-worker image sandbox smoke`, step
  `Scan the media-worker image (fixable HIGH and CRITICAL)`. Only the media-worker image is scanned there.
- **On every merge to `main`**, `.github/workflows/build-images.yml` (run by `deploy-staging.yml`, so it
  shows as a failed `Deploy (staging)` run, job `release images / api + media-worker (linux/arm64)`), steps
  `Scan the api image …` and `Scan the media-worker image …`. They scan the pushed images by digest with
  `--platform linux/arm64`. A failure here skips the sign + tag job, so staging keeps the previous release.

So a finding only in the api image first shows up after a merge, as a failed staging deploy, not as a red PR.
Nothing scans on a schedule: a new advisory surfaces on the next PR or the next merge.

## How to read a finding

The log has a `Report Summary` table, then one findings table per package type. From the 2026-10-26
failure of the api image (trimmed: one row of each table, no Title column):

```
│ usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json         │ node-pkg │        5        │

Node.js (node-pkg)
==================
Total: 10 (HIGH: 10, CRITICAL: 0)

│            Library             │  Vulnerability  │ Severity │ Status │ Installed Version │        Fixed Version         │
│ brace-expansion (package.json) │ CVE-2026-102276 │ HIGH     │ fixed  │ 2.0.2             │ 5.0.10, 3.0.7, 2.1.5, 1.1.19 │
```

- **Library**: the package. For a Debian package it is the package name (`libssl3`); for npm, the name
  followed by `(package.json)`.
- **Installed Version**: what the image has. **Fixed Version**: the releases that fix it, one per line the
  package maintains; you need the one in the line you are on (2.0.2 needs 2.1.5 or later).
- **Status** is always `fixed` in a failing run, since unfixed findings are skipped.
- **Origin**: the findings table drops the path (`Table result includes only package filenames`). Take it
  from the `Report Summary`: each row is a Target with its count, and the rows with a non-zero count are
  where the findings live. A Debian package shows as `<image> (debian 12.x)` with type `debian`; an npm
  package as the path of its `package.json` with type `node-pkg`.

With Docker, this lists every finding with its full path:

```sh
trivy image --quiet --format json civfix/media-worker:ci | jq -r '.Results[].Vulnerabilities[]? | [.Severity, .PkgName, .InstalledVersion, .FixedVersion, .PkgPath, .VulnerabilityID] | @tsv'
```

## Triage by origin

| Origin | How to tell in Trivy's output | Fix | Verify after |
| --- | --- | --- | --- |
| Debian package in the `node:22-bookworm-slim` base | Report Summary row `<image> (debian 12.x)`, type `debian`, with a non-zero count | Move the base digest to the newest one of the same tag (command below) in all four `FROM node:22-bookworm-slim@sha256:…` lines: `services/api/Dockerfile` (`base`, `runtime`) and `services/media-worker/Dockerfile` (`base`, `runtime`). Dependabot's weekly docker PR (Mondays, 3-day cooldown, no majors) moves all four at once: take it when there is one. If Debian has not shipped a fix, the gate already skips the finding | The `debian` row is back to 0, the PR's sandbox smoke job passes, and so does the next staging deploy |
| The Node.js binary (`/usr/local/bin/node`) | Trivy does not report it: the node image installs Node from a tarball, with no Debian package record, so a Node.js security release never turns the scan red. Watch https://nodejs.org/en/blog/vulnerability | The same base digest bump, once a node:22 image with the patched release is out | `docker run --rm --entrypoint node civfix/api:ci --version` prints the patched version, and the same for `civfix/media-worker:ci` |
| npm package in `node_modules` | A `node-pkg` Target. **`app/node_modules/…`** is our dependency. **`usr/local/lib/node_modules/…`** (npm, corepack) or **`root/.cache/node/corepack/…`** (a pnpm that corepack downloaded) is package-manager tooling the runtime stage must not carry: both 2026-10-26 failures were this | Our dependency: the same flow as a `pnpm audit` finding: bump the direct dependency, or add a floor under `overrides` in `pnpm-workspace.yaml` bounded inside the package's major, with its reason in the comment above. Tooling: never bump or ignore it; restore the runtime stage's `rm -rf` of npm, npx and corepack, and its `FROM` the plain node image rather than `base` | The Target is gone from the Report Summary, and `pnpm audit --audit-level high` (the CI gate) passes |
| ffmpeg or x264, built from source in `services/media-worker/Dockerfile` | Trivy does not report them: they are compiled with `make` and copied to `/usr/local/bin` with no package record, which Trivy does not detect. Advisories come from https://ffmpeg.org/security.html (ffmpeg) and the x264 `stable` branch (the Dockerfile header links it) | Raise `FFMPEG_VERSION` (with `FFMPEG_SHA256`) or `X264_COMMIT` (with `X264_SHA256`) by the bump steps in that Dockerfile's header: the `.asc` signature check against FFmpeg's release key and the sha256 of each tarball | The image builds (the build checks the signature, the hashes and the ffmpeg version), and the PR's sandbox smoke job passes: its preflight pushes an h264 and an hevc clip through the video lane |

The newest digest of the base tag:

```sh
docker buildx imagetools inspect node:22-bookworm-slim
grep -n 'FROM node:22-bookworm-slim@' services/api/Dockerfile services/media-worker/Dockerfile
```

The first prints the multi-arch index digest on its `Digest:` line; that is the one the `FROM` lines pin.

## Reproduce locally

This needs Docker and Trivy. From the repo root, with the same build commands as CI:

```sh
docker build -f services/media-worker/Dockerfile -t civfix/media-worker:ci .
trivy image civfix/media-worker:ci
docker build -f services/api/Dockerfile -t civfix/api:ci .
trivy image civfix/api:ci
```

The release scan runs on linux/arm64, and a local build is your machine's platform. If the two disagree,
the CI result is the one that blocks.

Agents and Mac sessions without Docker read the failing CI job's Trivy output instead. On a PR, open the
failed `media-worker image sandbox smoke` check. After a merge, the newest failed staging deploy:

```sh
gh run view "$(gh run list -R civfix/civfix-backend --workflow deploy-staging.yml --status failure --limit 1 --json databaseId --jq '.[0].databaseId')" -R civfix/civfix-backend --log-failed
```

## When a `.trivyignore` entry is acceptable

Almost never: the fix in the table is the answer. An entry is allowed only when one of these holds, and the
entry says which:

1. **No usable fix yet**: the fixed version exists only in a release we can't take yet (a new Debian major,
   a breaking upstream major).
2. **Provably unreachable**: the vulnerable code isn't loaded or called in that image. Name the file or
   package that shows it.

A CRITICAL that is reachable is never ignored.

The file is `.trivyignore` at the repo root (none exists today). Each entry is one advisory ID per line with
an expiry of at most 30 days from the day it merges, after Trivy's `exp:YYYY-MM-DD` suffix, so the gate
fails again when it lapses. The comment above it names the advisory, the package and its origin, which case
applies, and the version that removes it, the same way as the `ignoreGhsas` entry in `pnpm-workspace.yaml`.
An example only, not a real entry:

```
# CVE-2026-12345 (example-lib 2.4.1, our dependency under app/node_modules through example-parent). Case 1,
# no usable fix yet: it is fixed only in example-lib 3.0.0, a breaking major example-parent does not accept.
# Remove once example-parent allows example-lib 3 (example-parent 6.0.0).
CVE-2026-12345 exp:2026-11-29
```

An entry is renewed only by a new PR that sets a new date, with the same approval as a new one.

## Who approves

- **Every `.trivyignore` entry, new or renewed**: byteful. An agent may propose one in a PR, but never
  merges it.
- **A base digest bump, a dependency bump or an `overrides` floor, an ffmpeg or x264 bump**: the normal PR
  review, nothing more.
