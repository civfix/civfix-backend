import { randomUUID } from "node:crypto"
import { chmod, chown, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FILER_GROUP, lookupGid } from "./config.js"
import { runAsFiler, type FilerProcessOptions, type FilerRunner } from "./filer-process.js"

const FILER_UID = 1001

export const FILER_ENV_KEYS = ["HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR"] as const
const RUN_ENV_KEYS = ["FILER_RUN_DIR", "FILER_HOST"] as const

const CHECK_TIMEOUT_MS = 60_000
const NODE_AMBIENT_CAPS = (1n << 6n) | (1n << 7n) // CAP_SETGID, CAP_SETUID
const CLEARED_CAPS = ["CapInh", "CapPrm", "CapEff", "CapAmb"] as const
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url))

// --no-sandbox: Docker's seccomp profile and no_new_privs keep Chromium's own sandbox from starting
// (D7), so it would refuse to launch without the flag.
const CHROMIUM_CHECK = `import { chromium } from "playwright-core"
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
const page = await browser.newPage()
await page.goto("data:text/html,<p>ok</p>")
console.log(await page.textContent("p"))
await browser.close()`

// What filer must not be able to do to the workspace and a run, and the one thing it must (D7).
const PERMISSION_CHECK = `const fs = require("node:fs")
const [workspace, run] = process.argv.slice(1)
const attempt = (op) => { try { op(); return "ok" } catch (err) { return err.code } }
console.log(JSON.stringify({
  createAtTop: attempt(() => fs.writeFileSync(workspace + "/preflight-probe", "x")),
  renameRun: attempt(() => fs.renameSync(run, run + "-moved")),
  writePacket: attempt(() => fs.writeFileSync(run + "/packet.json", "{}")),
  replaceOut: attempt(() => fs.renameSync(run + "/out", run + "/out-old")),
  writeIntoOut: attempt(() => fs.writeFileSync(run + "/out/probe.txt", "x")),
}))`

function statusIds(status: string, label: string): number[] {
  const line = status.split("\n").find((l) => l.startsWith(`${label}:`))
  return (
    line
      ?.slice(label.length + 1)
      .trim()
      .split(/\s+/) ?? []
  ).map(Number)
}

function statusCaps(status: string, label: string): bigint | null {
  const hex = status
    .split("\n")
    .find((l) => l.startsWith(`${label}:`))
    ?.slice(label.length + 1)
    .trim()
  return hex !== undefined && /^[0-9a-f]+$/i.test(hex) ? BigInt(`0x${hex}`) : null
}

function idsFailure(status: string, label: "Uid" | "Gid", id: number): string | null {
  const ids = statusIds(status, label)
  return ids.length === 4 && ids.every((v) => v === id)
    ? null
    : `${label} is [${ids.join(" ")}], not ${id}`
}

/** Null when the preflight itself runs as node with ambient SETUID/SETGID, as the entrypoint leaves it. */
function nodeStatusFailure(status: string, nodeUid: number): string | null {
  const ambient = statusCaps(status, "CapAmb")
  return (
    idsFailure(status, "Uid", nodeUid) ??
    (ambient === NODE_AMBIENT_CAPS ? null : `CapAmb is ${ambient?.toString(16)}, not SETUID/SETGID`)
  )
}

/** Null when a filer process's /proc/self/status shows the filer uid and gid and no capabilities. */
export function filerStatusFailure(status: string): string | null {
  const caps = CLEARED_CAPS.find((name) => statusCaps(status, name) !== 0n)
  return (
    idsFailure(status, "Uid", FILER_UID) ??
    idsFailure(status, "Gid", FILER_UID) ??
    (caps === undefined
      ? null
      : `the filer process has ${caps} ${statusCaps(status, caps)?.toString(16)}`)
  )
}

/** Null when `env`'s output holds exactly the expected variables. */
export function envOutputFailure(output: string, expected: readonly string[]): string | null {
  const keys = output
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("=")[0] ?? "")
  const same =
    keys.length === expected.length &&
    [...expected].sort().every((k, i) => k === [...keys].sort()[i])
  return same ? null : `filer-shell env printed [${keys.join(" ")}], not [${expected.join(" ")}]`
}

export interface PreflightDeps {
  runner: FilerRunner
  workspaceDir: string
  /** The preflight's own /proc/self/status. */
  ownStatus: () => Promise<string>
  /** The uid of the image's `node` user, the one the entrypoint drops to. */
  nodeUid: number
  /** What filer-shell is spawned with: the preflight's own variables, as docker exec passes them. */
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}

function check(failure: string | null): void {
  if (failure !== null) throw new Error(failure)
}

async function checks(deps: PreflightDeps): Promise<void> {
  const asFiler = async (
    args: string[],
    opts: Partial<FilerProcessOptions> = {},
  ): Promise<string> => {
    const lines: string[] = []
    const out = await runAsFiler(deps.runner, {
      args,
      env: deps.env,
      timeoutMs: CHECK_TIMEOUT_MS,
      onStdoutLine: (line) => void lines.push(line),
      ...opts,
    })
    if (out.exitCode !== 0)
      throw new Error(`filer-shell ${args[0]} exited ${out.exitCode}: ${out.stderrTail}`)
    return lines.join("\n")
  }
  check(nodeStatusFailure(await deps.ownStatus(), deps.nodeUid))
  check(envOutputFailure(await asFiler(["env"]), FILER_ENV_KEYS))

  // A probe run laid out as the wrapper lays out a real one.
  const run = join(deps.workspaceDir, "runs", `preflight-${randomUUID()}`)
  const gid = lookupGid(FILER_GROUP)
  await mkdir(join(run, "out"), { recursive: true, mode: 0o750 })
  await writeFile(join(run, "packet.json"), "{}", { mode: 0o640 })
  for (const [path, mode] of [
    [join(run, "out"), 0o2770],
    [join(run, "packet.json"), 0o640],
    [run, 0o750],
  ] as const) {
    if (gid !== null) await chown(path, -1, gid)
    await chmod(path, mode)
  }
  try {
    const runEnv = await asFiler(["env"], { run: { dir: run, host: "preflight.invalid" } })
    check(envOutputFailure(runEnv, [...FILER_ENV_KEYS, ...RUN_ENV_KEYS]))
    const uid = (await asFiler(["id", "-u"])).trim()
    check(uid === String(FILER_UID) ? null : `filer-shell id -u printed ${uid}`)
    check(filerStatusFailure(await asFiler(["cat", "/proc/self/status"])))
    const page = await asFiler(
      [deps.runner.nodeBinary, "--input-type=module", "-e", CHROMIUM_CHECK],
      { cwd: PACKAGE_DIR },
    )
    check(page.trim() === "ok" ? null : "Chromium did not render a data: URL as filer")
    const ops = JSON.parse(
      await asFiler([deps.runner.nodeBinary, "-e", PERMISSION_CHECK, deps.workspaceDir, run]),
    ) as Record<string, string>
    const { writeIntoOut, ...denied } = ops
    for (const [op, code] of Object.entries(denied)) {
      check(code === "EACCES" || code === "EPERM" ? null : `filer could ${op} (${code})`)
    }
    check(writeIntoOut === "ok" ? null : `filer could not write into out/ (${writeIntoOut})`)
  } finally {
    await rm(run, { recursive: true, force: true })
  }
}

/** The exit code: 0 when every check passed, 1 at the first failure. */
export async function runPreflight(deps: PreflightDeps): Promise<number> {
  try {
    await checks(deps)
  } catch (err) {
    deps.log(`city-filer: preflight FAILED: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  deps.log("city-filer: preflight ok")
  return 0
}
