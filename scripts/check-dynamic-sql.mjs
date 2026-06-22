#!/usr/bin/env node
// Guardrail against drizzle/postgres.js dynamic-SQL injection (CVE-2026-39356 class).
// `sql.identifier(` and `sql.raw(` are zero-tolerance (none exist today; any use needs review).
// `sql.unsafe(` is permitted only in the reviewed, code-constant sites below.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOTS = ["services/api/src", "services/media-worker/src"]
const ALLOW_UNSAFE = new Set([
  "services/api/src/db/migrate.ts",
  "services/api/src/db/backfill-jurisdictions-core.ts",
  "services/api/src/db/sql/jurisdiction.ts",
  "services/api/src/services/media-worker-repo.ts",
])

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : []
  })

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

const violations = []
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const code = stripComments(readFileSync(file, "utf8"))
    if (/\bsql\.identifier\s*\(/.test(code)) violations.push(`${file}: sql.identifier() is forbidden`)
    if (/\bsql\.raw\s*\(/.test(code)) violations.push(`${file}: sql.raw() is forbidden`)
    if (/\bsql\.unsafe\s*\(/.test(code) && !ALLOW_UNSAFE.has(file))
      violations.push(`${file}: sql.unsafe() outside the reviewed allowlist`)
  }
}

if (violations.length > 0) {
  console.error("Dynamic-SQL guard failed:\n" + violations.map((v) => "  - " + v).join("\n"))
  process.exit(1)
}
console.log("Dynamic-SQL guard: clean")
