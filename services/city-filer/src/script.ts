import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { runAsFiler, type FilerRunner } from "./filer-process.js"
import { readContainedFile } from "./safe-file.js"

const SCRIPT_MAX_BYTES = 1024 * 1024
const SCRIPT_VERSION_HEX = 12
// The kit's own names (kit/index.mjs), which a script cannot import into the wrapper.
const DRY_RUN_SENTINEL = "CIVFIX_FILER_DRY_RUN_OK"
export const SUBMIT_MARKER = ".submit-clicked"

/** A bare hostname, so it can only ever name a directory directly under portals/. */
export function isPortalHost(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host)
}

export type PortalScript =
  | { kind: "missing" }
  | { kind: "rejected"; why: string }
  | { kind: "ok"; bytes: Buffer; sha256: string; version: string }

/** `portals/<host>/script.mjs`, which `filer` writes, read as `node` without trusting it (D7). */
export async function readPortalScript(workspaceDir: string, host: string): Promise<PortalScript> {
  const portals = await realpath(join(workspaceDir, "portals"))
  const hostDir = join(portals, host)
  try {
    if (!(await lstat(hostDir)).isDirectory())
      return { kind: "rejected", why: "the host entry is not a directory" }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    throw err
  }
  const read = await readContainedFile(join(hostDir, "script.mjs"), {
    maxBytes: SCRIPT_MAX_BYTES,
    parentDir: hostDir,
  })
  if (read.kind !== "ok") return read
  const sha256 = createHash("sha256").update(read.bytes).digest("hex")
  return { kind: "ok", bytes: read.bytes, sha256, version: sha256.slice(0, SCRIPT_VERSION_HEX) }
}

export interface ScriptRunResult {
  exitCode: number | null
  timedOut: boolean
  /** The kit's dry-run sentinel, with this script's sha256, arrived on the wrapper's own stdout pipe. */
  sentinel: boolean
  /** out/.submit-clicked exists: the live submit may have been clicked. */
  marker: boolean
}

export interface ScriptRunOptions {
  runDir: string
  host: string
  dryRun: boolean
  scriptSha256: string
  timeoutMs: number
}

/** One `run-script` run as `filer`. #177's dry-run proof is this call with `dryRun: true`. */
export async function runScript(
  runner: FilerRunner,
  opts: ScriptRunOptions,
): Promise<ScriptRunResult> {
  const expected = `${DRY_RUN_SENTINEL} ${opts.scriptSha256}`
  let sentinel = false
  const run = await runAsFiler(runner, {
    args: [
      runner.nodeBinary,
      runner.kitRunScript,
      opts.runDir,
      ...(opts.dryRun ? ["--dry-run"] : []),
    ],
    run: { dir: opts.runDir, host: opts.host },
    timeoutMs: opts.timeoutMs,
    cwd: opts.runDir,
    onStdoutLine: (line) => {
      if (line === expected) sentinel = true
    },
  })
  const marker = await lstat(join(opts.runDir, "out", SUBMIT_MARKER)).then(
    () => true,
    () => false,
  )
  return { exitCode: run.exitCode, timedOut: run.timedOut, sentinel, marker }
}
