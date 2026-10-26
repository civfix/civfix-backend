// The filer kit (epic civfix/issue-tracker#164, D7): what a workspace script at
// portals/<host>/script.mjs imports as "@civfix/filer-kit". run-script.mjs starts the run, so the
// functions here know the run directory and whether this is a dry run.
import { writeSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

// The wrapper matches it (src/script.ts) only on its own stdout pipe.
const DRY_RUN_SENTINEL = "CIVFIX_FILER_DRY_RUN_OK"

const run = {
  outDir: null,
  dryRun: false,
  scriptSha256: "",
}

/** run-script.mjs only. */
export function startRun({ runDir, dryRun, scriptSha256 }) {
  Object.assign(run, { outDir: join(runDir, "out"), dryRun, scriptSha256 })
}

function outDir() {
  if (run.outDir === null) throw new Error("the filer kit runs only under run-script.mjs")
  return run.outDir
}

function printSentinel() {
  // Written straight to the pipe, so it is out before the process can exit.
  writeSync(1, `${DRY_RUN_SENTINEL} ${run.scriptSha256}\n`)
}

export async function launch() {
  throw new Error("not implemented")
}

export async function screenshot(_label) {
  throw new Error("not implemented")
}

export async function submit(_locator) {
  throw new Error("not implemented")
}

/**
 * out/result.json: { outcome: "submitted" | "linked_existing" | "needs_human", caseId?, caseUrl?,
 * reason?, reasonDetail?, evidence? }. A dry run that finds a similar request has reached its last
 * step, so it proves the script as the final submit does (D8).
 */
export async function result(r) {
  const body = { ...r, evidence: r.evidence ?? [] }
  await writeFile(join(outDir(), "result.json"), JSON.stringify(body))
  if (run.dryRun && r.outcome === "linked_existing") printSentinel()
}
