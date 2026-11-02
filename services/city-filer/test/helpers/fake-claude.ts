import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** What one fake `claude` process saw, as it recorded it at its start. */
export interface ClaudeCall {
  n: number
  argv: string[]
  env: Record<string, string>
  stdin: string
  cwd: string
  /** Another fake claude was running when this one started. */
  overlapped: boolean
  /** Every file under HOME, relative to it. */
  home: string[]
}

/**
 * The fake CLI: node, started by bin/claude's shebang (no shell in between, which would add PWD), records
 * its call, runs the test's act and prints what the act returns, by default a successful
 * `--output-format json` result. The act gets { n, argv, stdin, runDir, host, home, state }
 * and may return an object (printed as JSON) or a string (printed as is).
 */
const FAKE_CLAUDE = (
  state: string,
) => `import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const state = ${JSON.stringify(state)}
const argv = process.argv.slice(2)
const stdin = readFileSync(0, "utf8")
let overlapped = false
try { mkdirSync(join(state, "running")) } catch { overlapped = true }
const n = readdirSync(join(state, "calls")).length
const list = (dir, rel = "") => readdirSync(join(dir, rel)).flatMap((name) => {
  const r = rel === "" ? name : rel + "/" + name
  return statSync(join(dir, r)).isDirectory() ? list(dir, r) : [r]
})
const home = list(process.env.HOME).sort()
const call = { n, argv, env: process.env, stdin, cwd: process.cwd(), overlapped, home }
writeFileSync(join(state, "calls", String(n).padStart(3, "0") + "-" + process.pid + ".json"), JSON.stringify(call))
const { default: act } = await import(join(state, "act.mjs"))
const out = await act({ n, argv, stdin, runDir: process.env.FILER_RUN_DIR, host: process.env.FILER_HOST, home: process.env.HOME, state })
if (!overlapped) rmdirSync(join(state, "running"))
process.stdout.write(typeof out === "string" ? out : JSON.stringify(out ?? { type: "result", subtype: "success", is_error: false, result: "done" }))
`

/** The act's module: `body` runs with fs, git and the paths in scope. */
const ACT = (workspace: string, body: string) => `import fs from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { join } from "node:path"
const workspace = ${JSON.stringify(workspace)}
const git = (...args) => execFileSync("git", ["-c", "user.name=Claude", "-c", "user.email=claude@civfix.invalid", "-C", workspace, ...args])
const writeScript = (source, host) => {
  fs.mkdirSync(join(workspace, "portals", host), { recursive: true })
  fs.writeFileSync(join(workspace, "portals", host, "script.mjs"), source)
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
export default async function act({ n, argv, stdin, runDir, host, home, state }) {
${body}
}
`

export async function installFakeClaude(
  dir: string,
  workspace: string,
  body: string,
): Promise<void> {
  const state = join(dir, "claude-state")
  await mkdir(join(state, "calls"), { recursive: true })
  await mkdir(join(dir, "bin"), { recursive: true })
  await writeFile(join(state, "act.mjs"), ACT(workspace, body))
  await writeFile(join(state, "fake-claude.mjs"), FAKE_CLAUDE(state))
  // The executable itself is CommonJS (no package.json says otherwise) and only loads the module.
  const loader = `#!${process.execPath}\nvoid import(${JSON.stringify(join(state, "fake-claude.mjs"))})\n`
  await writeFile(join(dir, "bin", "claude"), loader, { mode: 0o755 })
}

/** Every fake claude call so far, in order. */
export async function claudeCalls(dir: string): Promise<ClaudeCall[]> {
  const calls = join(dir, "claude-state", "calls")
  const names = (await readdir(calls).catch(() => [])).sort()
  return Promise.all(
    names.map(async (n) => JSON.parse(await readFile(join(calls, n), "utf8")) as ClaudeCall),
  )
}
