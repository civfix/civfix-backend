import { readdirSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const dir = new URL("../dist/db/", import.meta.url)
const failures = []

for (const tool of ["pnpm", "corepack"]) {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "pipe" })
    failures.push(`${tool} is on PATH in the runtime image`)
  } catch {}
}

const specifiers = new Set()
for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const source = readFileSync(new URL(file, dir), "utf8")
  for (const [, spec] of source.matchAll(/^import [^"]*"([^"./][^"]*)";$/gm)) {
    if (!spec.startsWith("node:")) specifiers.add(spec)
  }
}

for (const spec of specifiers) {
  try {
    await import(spec)
  } catch (err) {
    failures.push(`${spec}: ${err.code ?? err.message}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
console.log(`image smoke ok: ${specifiers.size} db script dependencies resolve, no pnpm`)
