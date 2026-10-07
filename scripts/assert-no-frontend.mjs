#!/usr/bin/env node
// Backend-isolation guard, run in CI. The backend depends ONLY on @civfix/shared, the framework-free
// contract. React, React Native, react-native-web or @civfix/ui (which carries React/RN peers)
// appearing here means an install or a stray dependency edit leaked the UI layer into the backend.
//
// Two independent checks:
//   1. pnpm-lock.yaml (read as TEXT) must contain no RESOLVED package whose key is react, react-dom,
//      react-native, react-native-web, or @civfix/ui. We match lockfile-v9 package keys precisely so
//      unrelated peer-dependency declarations (e.g. `react-native-b4a: '*'` under b4a, or `react: '>=18'`
//      under drizzle-orm) do NOT trip the guard -- those are optional peers, never resolved here. This
//      makes Check 1 the lockfile equivalent of `pnpm why react react-native react-native-web -> not
//      found`.
//   2. services/api and services/media-worker package.json must not list react / react-dom /
//      react-native in dependencies or devDependencies.
//
// Run: node scripts/assert-no-frontend.mjs  (exit 0 = clean, exit 1 = leak found).

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const failures = []

// In pnpm-lock v9 a resolved package is a key in the top-level `packages:` (and `snapshots:`) maps,
// written as `  <name>@<version>:` at a two-space indent. A scoped name may be quoted. We anchor each
// pattern to start-of-line + two spaces + the exact package name + `@`, so:
//   - `react@...`             matches; the trailing `@` boundary stops it from matching `react-dom@`,
//                             `react-is@`, `react-native@`, or the scoped `'@types/react@'` (which
//                             starts with `@`, not `react`). The two-space anchor stops it from matching
//                             the deeply indented `react: '>=18'` peer DECLARATION (6 spaces, no `@`).
//   - `react-dom@...`         has its own dedicated pattern; the `@` boundary stops it from matching a
//                             hypothetical `react-dom-something@` package.
//   - `react-native@...`      matches; `react-native-b4a: '*'` (a peer decl) does NOT (no `@`, and the
//                             `@` boundary stops `react-native` from matching `react-native-b4a`).
//   - `react-native-web@...`  has its own dedicated pattern.
//   - `@civfix/ui@...`        matches whether or not the scoped key is quoted.
const LOCKFILE = "pnpm-lock.yaml"
const lockfilePath = join(repoRoot, LOCKFILE)

const BANNED_LOCKFILE_PACKAGES = [
  { name: "react", re: /^ {2}["']?react@/m },
  { name: "react-dom", re: /^ {2}["']?react-dom@/m },
  { name: "react-native", re: /^ {2}["']?react-native@/m },
  { name: "react-native-web", re: /^ {2}["']?react-native-web@/m },
  { name: "@civfix/ui", re: /^ {2}["']?@civfix\/ui@/m },
]

let lockfileText
try {
  lockfileText = readFileSync(lockfilePath, "utf8")
} catch (err) {
  console.error(
    `[assert-no-frontend] FAIL: could not read ${LOCKFILE} at ${lockfilePath}: ${err.message}`,
  )
  process.exit(1)
}

for (const { name, re } of BANNED_LOCKFILE_PACKAGES) {
  if (re.test(lockfileText)) {
    failures.push(
      `${LOCKFILE} resolves a banned frontend package "${name}". The backend must not depend on ` +
        `React/React Native or @civfix/ui (which carries them). Remove the dependency that pulled it in.`,
    )
  }
}

const BANNED_MANIFEST_DEPS = ["react", "react-dom", "react-native"]
const SERVICE_MANIFESTS = ["services/api/package.json", "services/media-worker/package.json"]

for (const rel of SERVICE_MANIFESTS) {
  const manifestPath = join(repoRoot, rel)
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (err) {
    failures.push(`could not read/parse ${rel}: ${err.message}`)
    continue
  }
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  for (const dep of BANNED_MANIFEST_DEPS) {
    if (Object.prototype.hasOwnProperty.call(declared, dep)) {
      failures.push(`${rel} declares a banned frontend dependency "${dep}" (deps/devDeps).`)
    }
  }
}

if (failures.length > 0) {
  console.error("[assert-no-frontend] FAIL: backend pulled in frontend runtime deps:")
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(
  "[assert-no-frontend] OK: no react / react-dom / react-native / react-native-web / @civfix/ui in the " +
    "backend lockfile or service manifests.",
)
