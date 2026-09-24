import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// tsup bundles every CLI entry with splitting off, so an imported module's import.meta.url becomes
// the entry's own URL. A run-as-main guard in any module a CLI imports then fires inside that CLI and
// runs the wrong main.
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const SOURCE_DIRS = ["src", "scripts"]
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+?)\.js["']/g
const RUN_AS_MAIN_GUARD =
  /^runIfMain\(|fileURLToPath\(import\.meta\.url\)\s*===\s*process\.argv\[1\]/m

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : []
  })
}

function relativeImports(file: string): string[] {
  const source = readFileSync(file, "utf8")
  return [...source.matchAll(RELATIVE_IMPORT)]
    .map((match) => resolve(dirname(file), `${match[1]}.ts`))
    .filter((path) => existsSync(path))
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>()
  const pending = relativeImports(entry)
  while (pending.length > 0) {
    const next = pending.pop()!
    if (next === entry || seen.has(next)) continue
    seen.add(next)
    pending.push(...relativeImports(next))
  }
  return seen
}

const allFiles = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(API_ROOT, dir)))
const guardedModules = allFiles.filter((file) => RUN_AS_MAIN_GUARD.test(readFileSync(file, "utf8")))
const cliEntries = [
  ...new Set([...guardedModules, ...sourceFiles(join(API_ROOT, "scripts"))]),
].sort()

describe("CLI entries import only guard-free modules", () => {
  it("finds the seed-demo-la entry and its guarded siblings", () => {
    expect(cliEntries).toContain(join(API_ROOT, "src/db/seed-demo-la.ts"))
    expect(guardedModules).toContain(join(API_ROOT, "src/db/demo-join-event.ts"))
  })

  it.each(cliEntries.map((entry) => [relative(API_ROOT, entry), entry]))(
    "%s reaches no other module with a run-as-main guard",
    (_label, entry) => {
      const offenders = [...reachableFrom(entry)]
        .filter((file) => guardedModules.includes(file))
        .map((file) => relative(API_ROOT, file))
      expect(offenders).toEqual([])
    },
  )
})
