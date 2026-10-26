import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FakeJobs, FakeStorage } from "@civfix/seams"
import {
  FILING_CITY_UPDATE_JOB,
  FILING_CLASSIFY_JOB,
  FILING_RESULT_JOB,
  FILING_RUN_JOB,
  type FilingCityUpdateJobData,
  type FilingResultPayload,
} from "@civfix/api/filings-worker"
import { makeClaudeGate } from "../../src/claude.js"
import { makeClassifyHandler } from "../../src/classify.js"
import { loadConfig, type FilerConfig } from "../../src/config.js"
import type { FilerRunner } from "../../src/filer-process.js"
import { makeFilingRunHandler } from "../../src/run-filing.js"
import { FakeFilingsWorker, PORTAL_HOST } from "./fake-filings-worker.js"
import { claudeCalls, installFakeClaude } from "./fake-claude.js"

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
  FILER_RUN_MODEL: "test-run-model",
  FILER_CLASSIFY_MODEL: "test-classify-model",
}

/** Run as the test user, never by the wrapper: the wrapper's git goes through filer-shell (src/git.ts). */
export function testGit(workspace: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@civfix.invalid", "-C", workspace, ...args],
    { encoding: "utf8" },
  )
}

/**
 * bin/filer-shell without its setpriv line, so a test that is not root runs the same `env -i` line as
 * itself; HOME and the browsers path point at what this machine has, and PATH starts with the test's own
 * bin/, where a fake `claude` goes.
 */
async function fakeFilerShell(dir: string): Promise<string> {
  const source = await readFile(join(PACKAGE_DIR, "bin", "filer-shell"), "utf8")
  const setpriv = source.split("\n").filter((l) => l.includes("/usr/bin/setpriv"))
  if (setpriv.length !== 1) throw new Error("bin/filer-shell no longer has one setpriv line")
  await mkdir(join(dir, "home"))
  const fake = source
    .replace(setpriv[0] ?? "", "")
    .replace("HOME=/home/filer", `HOME=${join(dir, "home")}`)
    .replace("PATH=/usr/local/bin", `PATH=${join(dir, "bin")}:/usr/local/bin`)
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

export interface Spawned {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv | undefined
}

export async function filerHarness(
  over: Partial<Pick<FilerConfig, "dryRun" | "scriptTimeoutMs">> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "city-filer-"))
  const workspace = await makeWorkspace(dir)
  // D7's repository: runs/ and node_modules/ ignored, one empty commit.
  await writeFile(join(workspace, ".gitignore"), "runs/\nnode_modules/\n")
  testGit(workspace, "init", "--quiet", "-b", "main")
  testGit(workspace, "commit", "--quiet", "--allow-empty", "-m", "workspace")
  const spawnEnvs: (NodeJS.ProcessEnv | undefined)[] = []
  const spawns: Spawned[] = []
  const runner: FilerRunner = {
    filerShell: await fakeFilerShell(dir),
    nodeBinary: process.execPath,
    kitRunScript: join(KIT_DIR, "run-script.mjs"),
    spawn: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnEnvs.push(options.env)
      spawns.push({ command, args, env: options.env })
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
  const gate = makeClaudeGate()
  const deps = { filings, jobs, storage, config, runner, gate, log, report: () => {} }
  await jobs.work(FILING_RUN_JOB, makeFilingRunHandler(deps))
  const classifyHandler = makeClassifyHandler(deps)
  await jobs.work(FILING_CLASSIFY_JOB, classifyHandler)

  async function installScript(source: string | Buffer, host = PORTAL_HOST): Promise<Buffer> {
    await mkdir(join(workspace, "portals", host), { recursive: true })
    await writeFile(join(workspace, "portals", host, "script.mjs"), source)
    return Buffer.from(source)
  }

  /** The `filer-shell -- <args>` spawns running `node <kit>/run-script.mjs`: proofs and live runs. */
  const scriptRuns = () =>
    spawns
      .filter((s) => s.args.includes(runner.kitRunScript))
      .map((s) => (s.args.includes("--dry-run") ? "dry-run" : "live"))

  return {
    ...deps,
    dir,
    workspace,
    home: join(dir, "home"),
    logs,
    spawnEnvs,
    spawns,
    scriptRuns,
    classifyHandler,
    /** Puts a fake `claude` on filer-shell's PATH that acts as `act` says (test/helpers/fake-claude.ts). */
    claude: (act: string) => installFakeClaude(dir, workspace, act),
    claudeCalls: () => claudeCalls(dir),
    async classify(data: { filingMessageId: string; subject: string; text: string }) {
      await jobs.enqueue(FILING_CLASSIFY_JOB, data)
      return jobs.jobsFor(FILING_CLASSIFY_JOB).at(-1)?.state
    },
    cityUpdates: () =>
      jobs.jobsFor(FILING_CITY_UPDATE_JOB).map((j) => ({
        data: j.data as FilingCityUpdateJobData,
        singletonKey: j.opts?.singletonKey,
      })),
    installScript,
    installFixtureScript: async () =>
      installScript(await readFile(join(PACKAGE_DIR, "test", "fixtures", "portal-script.mjs"))),
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
