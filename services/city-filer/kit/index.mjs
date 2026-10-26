// The filer kit (epic civfix/issue-tracker#164, D7): what a workspace script at
// portals/<host>/script.mjs imports as "@civfix/filer-kit". run-script.mjs starts the run, so the
// functions here know the run directory and whether this is a dry run.
import { writeSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"

// The wrapper matches these (src/script.ts): the sentinel only on its own stdout pipe.
const DRY_RUN_SENTINEL = "CIVFIX_FILER_DRY_RUN_OK"
const SUBMIT_MARKER = ".submit-clicked"

const run = {
  outDir: null,
  dryRun: false,
  scriptSha256: "",
  context: null,
  page: null,
  profileDir: null,
  evidence: [],
}

/** run-script.mjs only. */
export function startRun({ runDir, dryRun, scriptSha256 }) {
  Object.assign(run, { outDir: join(runDir, "out"), dryRun, scriptSha256 })
}

/** run-script.mjs only: closes the browser and drops its profile. */
export async function endRun() {
  await run.context?.close()
  if (run.profileDir !== null) await rm(run.profileDir, { recursive: true, force: true })
  run.context = null
  run.profileDir = null
}

function outDir() {
  if (run.outDir === null) throw new Error("the filer kit runs only under run-script.mjs")
  return run.outDir
}

function printSentinel() {
  // Written straight to the pipe: a dry-run submit() exits right after it.
  writeSync(1, `${DRY_RUN_SENTINEL} ${run.scriptSha256}\n`)
}

/** Headless Chromium on a fresh profile under TMPDIR; the page is what screenshot() captures. */
export async function launch() {
  outDir()
  run.profileDir = await mkdtemp(join(tmpdir(), "filer-profile-"))
  // Chromium's own sandbox cannot start here: Docker's seccomp profile and no_new_privs block the
  // namespaces it needs. filer-shell's uid drop and the container are the sandbox instead.
  run.context = await chromium.launchPersistentContext(run.profileDir, {
    headless: true,
    args: ["--no-sandbox"],
  })
  run.page = run.context.pages()[0] ?? (await run.context.newPage())
  return { context: run.context, page: run.page }
}

/** A full-page PNG in out/, listed as evidence by result(); returns its file name. */
export async function screenshot(label) {
  if (run.page === null) throw new Error("screenshot() needs launch() first")
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
  const name = `${String(run.evidence.length + 1).padStart(2, "0")}-${slug || "page"}.png`
  await run.page.screenshot({ path: join(outDir(), name), fullPage: true })
  run.evidence.push(name)
  return name
}

/**
 * The final submit. Live, the marker is written before the click, so a crash between the two reads as a
 * submit that may have landed (D6). A dry run stops here instead: screenshot, result, sentinel, exit 0.
 */
export async function submit(locator) {
  if (run.dryRun) {
    await screenshot("before submit")
    await writeResult({ outcome: "needs_human", reason: "dry_run" })
    printSentinel()
    await endRun()
    process.exit(0)
  }
  await writeFile(join(outDir(), SUBMIT_MARKER), "")
  await locator.click()
}

async function writeResult(r) {
  const body = { ...r, evidence: r.evidence ?? [...run.evidence] }
  await writeFile(join(outDir(), "result.json"), JSON.stringify(body))
}

/**
 * out/result.json: { outcome: "submitted" | "linked_existing" | "needs_human", caseId?, caseUrl?,
 * reason?, reasonDetail?, evidence? }, evidence defaulting to every screenshot taken. A dry run that
 * finds a similar request has reached its last step, so it proves the script as submit() does (D8).
 */
export async function result(r) {
  await writeResult(r)
  if (run.dryRun && r.outcome === "linked_existing") printSentinel()
}
