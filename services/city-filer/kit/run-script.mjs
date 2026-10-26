// node /app/kit/run-script.mjs <run-dir> [--dry-run], as `filer` through filer-shell: runs the portal's
// workspace script on the run's packet. FILER_HOST names the portal; the workspace is the run
// directory's grandparent (/workspace/runs/<id>-<runId>). A script that throws exits non-zero.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
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

const scriptPath = join(resolve(runDir, "..", ".."), "portals", host, "script.mjs")
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
