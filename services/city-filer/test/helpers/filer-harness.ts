import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FakeJobs, FakeStorage } from "@civfix/seams"
import {
  FILING_RESULT_JOB,
  FILING_RUN_JOB,
  type FilingResultPayload,
} from "@civfix/api/filings-worker"
import { loadConfig, type FilerConfig } from "../../src/config.js"
import type { FilerRunner } from "../../src/filer-process.js"
import { makeFilingRunHandler } from "../../src/run-filing.js"
import { FakeFilingsWorker, PORTAL_HOST } from "./fake-filings-worker.js"

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url))
const KIT_DIR = join(PACKAGE_DIR, "kit")

export const CONTACT = {
  firstName: "CivFix",
  lastName: "Reports",
  email: "filings@civfix.org",
  phone: null,
}

/** The filer's env as the image gets it, FILER_DRY_RUN unset unless a test sets it. */
const FILER_ENV = {
  FILING_CONTACT_FIRST_NAME: CONTACT.firstName,
  FILING_CONTACT_LAST_NAME: CONTACT.lastName,
  FILING_CONTACT_EMAIL: CONTACT.email,
}

/**
 * bin/filer-shell without its setpriv line, so a test that is not root runs the same `env -i` line as
 * itself; HOME and the browsers path point at what this machine has.
 */
async function fakeFilerShell(dir: string): Promise<string> {
  const source = await readFile(join(PACKAGE_DIR, "bin", "filer-shell"), "utf8")
  const setpriv = source.split("\n").filter((l) => l.includes("/usr/bin/setpriv"))
  if (setpriv.length !== 1) throw new Error("bin/filer-shell no longer has one setpriv line")
  await mkdir(join(dir, "home"))
  const fake = source
    .replace(setpriv[0] ?? "", "")
    .replace("HOME=/home/filer", `HOME=${join(dir, "home")}`)
    .replace("=/ms-playwright", `=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright"}`)
  await writeFile(join(dir, "filer-shell"), fake, { mode: 0o755 })
  return join(dir, "filer-shell")
}

/** D7's /workspace layout: runs/, portals/ and the kit link a script's import resolves through. */
export async function makeWorkspace(dir: string): Promise<string> {
  const workspace = join(dir, "workspace")
  await mkdir(join(workspace, "runs"), { recursive: true })
  await mkdir(join(workspace, "portals"))
  await mkdir(join(workspace, "node_modules", "@civfix"), { recursive: true })
  await symlink(KIT_DIR, join(workspace, "node_modules", "@civfix", "filer-kit"))
  return workspace
}

export async function filerHarness(
  over: Partial<Pick<FilerConfig, "dryRun" | "scriptTimeoutMs">> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "city-filer-"))
  const workspace = await makeWorkspace(dir)
  const spawnEnvs: (NodeJS.ProcessEnv | undefined)[] = []
  const runner: FilerRunner = {
    filerShell: await fakeFilerShell(dir),
    nodeBinary: process.execPath,
    kitRunScript: join(KIT_DIR, "run-script.mjs"),
    spawn: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnEnvs.push(options.env)
      return spawn(command, args, options)
    }) as typeof spawn,
  }
  const config: FilerConfig = {
    ...loadConfig(over.dryRun === true ? { ...FILER_ENV, FILER_DRY_RUN: "true" } : FILER_ENV),
    workspaceDir: workspace,
    scriptTimeoutMs: over.scriptTimeoutMs ?? 60_000,
  }
  const filings = new FakeFilingsWorker()
  const storage = new FakeStorage()
  const jobs = new FakeJobs()
  const logs: { line: string; fields?: Record<string, unknown> }[] = []
  const log = (line: string, fields?: Record<string, unknown>) => void logs.push({ line, fields })
  const deps = { filings, jobs, storage, config, runner, log, report: () => {} }
  await jobs.work(FILING_RUN_JOB, makeFilingRunHandler(deps))

  async function installScript(source: string | Buffer, host = PORTAL_HOST): Promise<Buffer> {
    await mkdir(join(workspace, "portals", host), { recursive: true })
    await writeFile(join(workspace, "portals", host, "script.mjs"), source)
    return Buffer.from(source)
  }

  return {
    ...deps,
    workspace,
    logs,
    spawnEnvs,
    installScript,
    async run(filingId: string, attempt = 1) {
      await jobs.enqueue(FILING_RUN_JOB, { filingId, attempt })
      return jobs.jobsFor(FILING_RUN_JOB).at(-1)?.state
    },
    results: () => jobs.jobsFor(FILING_RESULT_JOB).map((j) => j.data as FilingResultPayload),
    /** Each result as "outcome/reason". */
    endings: () =>
      jobs.jobsFor(FILING_RESULT_JOB).map((j) => {
        const r = j.data as FilingResultPayload
        return `${r.outcome}/${r.reason ?? ""}`
      }),
    runDir: (filingId: string, runId: string | null) =>
      join(workspace, "runs", `${filingId}-${runId}`),
    close: () => rm(dir, { recursive: true, force: true }),
  }
}

export type FilerHarness = Awaited<ReturnType<typeof filerHarness>>
