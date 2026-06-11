#!/usr/bin/env node
// Stage 0.7 (UI-unification) backend-isolation guard.
//
// The civfix backend (Fastify API + media worker) depends ONLY on @civfix/shared, the framework-free
// contract. It must never pull in frontend runtime deps: React, React Native, react-native-web, or the
// new @civfix/ui package (which carries React/RN peers). If any of those ever appear, an install or a
// stray dependency edit introduced a leak between the backend and the UI layer, and this script fails
// CI so it gets caught before it ships.
//
// Two independent checks:
//   1. pnpm-lock.yaml (read as TEXT) must contain no RESOLVED package whose key is react-native,
//      react-native-web, or @civfix/ui. We match lockfile-v9 package keys precisely so unrelated
//      peer-dependency declarations (e.g. `react-native-b4a: '*'` under b4a, or `react: '>=18'` under
//      drizzle-orm) do NOT trip the guard -- those are optional peers, never resolved here.
//   2. services/api and services/media-worker package.json must not list react / react-dom /
//      react-native in dependencies or devDependencies.
//
// ESM, ASCII only. Run: node scripts/assert-no-frontend.mjs  (exit 0 = clean, exit 1 = leak found).

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Collected human-readable failures; non-empty => exit 1. */
const failures = []

// ---------------------------------------------------------------------------
// Check 1: the pnpm lockfile must not RESOLVE any banned frontend package.
//
// In pnpm-lock v9 a resolved package is a key in the top-level `packages:` (and `snapshots:`) maps,
// written as `  <name>@<version>:` at a two-space indent. A scoped name may be quoted. We anchor each
// pattern to start-of-line + two spaces + the exact package name + `@`, so:
//   - `react-native@...`      matches; `react-native-b4a: '*'` (a peer decl) does NOT (no `@`, and the
//                             `@` boundary stops `react-native` from matching `react-native-b4a`).
//   - `react-native-web@...`  has its own dedicated pattern.
//   - `@civfix/ui@...`        matches whether or not the scoped key is quoted.
// ---------------------------------------------------------------------------
const LOCKFILE = "pnpm-lock.yaml"
const lockfilePath = join(repoRoot, LOCKFILE)

/** Each entry: a banned resolved-package name + the regex that matches its lockfile-v9 key line. */
const BANNED_LOCKFILE_PACKAGES = [
  { name: "react-native", re: /^ {2}["']?react-native@/m },
  { name: "react-native-web", re: /^ {2}["']?react-native-web@/m },
  { name: "@civfix/ui", re: /^ {2}["']?@civfix\/ui@/m },
]

let lockfileText
try {
  lockfileText = readFileSync(lockfilePath, "utf8")
} catch (err) {
  console.error(`[assert-no-frontend] FAIL: could not read ${LOCKFILE} at ${lockfilePath}: ${err.message}`)
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

// ---------------------------------------------------------------------------
// Check 2: backend service manifests must not declare React/RN directly.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error("[assert-no-frontend] FAIL: backend pulled in frontend runtime deps:")
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(
  "[assert-no-frontend] OK: no react / react-dom / react-native / react-native-web / @civfix/ui in the " +
    "backend lockfile or service manifests.",
)
