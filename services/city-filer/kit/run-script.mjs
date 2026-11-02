// node /app/kit/run-script.mjs <run-dir> [--dry-run], as `filer` through filer-shell: runs the portal's
// workspace script on the run's packet. FILER_HOST names the portal; the workspace is the run
// directory's grandparent (/workspace/runs/<id>-<runId>). A script that throws exits non-zero.
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { endRun, startRun } from "./index.mjs"

const [runDir, ...flags] = process.argv.slice(2)
const host = process.env.FILER_HOST ?? ""
if (
  runDir === undefined ||
  flags.some((f) => f !== "--dry-run") ||
  !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host)
) {
  console.error("usage: FILER_HOST=<host> node run-script.mjs <run-dir> [--dry-run]")
  process.exit(64)
}

const workspaceDir = resolve(runDir, "..", "..")
// Everywhere filer can write (the image's root filesystem is read-only). The proved fingerprint covers
// only portals/<host>/, so code loaded from anywhere else in these could change after the proof (#177).
// The kit and the image's node_modules resolve outside all of them.
const FILER_WRITABLE_ROOTS = [workspaceDir, tmpdir(), homedir(), "/tmp"]

const writableRoots = FILER_WRITABLE_ROOTS.map((dir) => realpathSync(dir))
const ownFolder = join(realpathSync(join(workspaceDir, "portals")), host)
const within = (dir, path) => {
  const rel = relative(dir, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// In-thread hooks, so they see static import, import() and require (createRequire's too) alike.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    if (resolved.url.startsWith("node:")) return resolved
    const path = resolved.url.startsWith("file:") ? realpathSync(fileURLToPath(resolved.url)) : null
    if (path !== null && (within(ownFolder, path) || !writableRoots.some((r) => within(r, path)))) {
      return resolved
    }
    throw new Error(
      `a portal script may load code only from portals/${host}/, the kit and the image: refused ${path ?? resolved.url}`,
    )
  },
})

const scriptPath = join(workspaceDir, "portals", host, "script.mjs")
const scriptSha256 = createHash("sha256")
  .update(await readFile(scriptPath))
  .digest("hex")
const packet = JSON.parse(await readFile(join(runDir, "packet.json"), "utf8"))
startRun({ runDir, dryRun: flags.includes("--dry-run"), scriptSha256 })
try {
  const script = await import(pathToFileURL(scriptPath).href)
  await script.default(packet)
} finally {
  await endRun()
}
