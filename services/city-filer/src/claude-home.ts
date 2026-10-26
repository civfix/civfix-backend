import type { FilerLog } from "./config.js"
import { runAsFiler, type FilerRunner } from "./filer-process.js"

/**
 * All that survives in /home/filer between Claude runs (D9): the login, and claude-swap's account store
 * (a trailing slash keeps a directory whole). A filing run has permissions skipped, so anything else it
 * leaves there (settings, hooks, memory, a CLAUDE.md, MCP servers) could steer the next run.
 */
const CLAUDE_HOME_KEEP = [
  ".claude/.credentials.json",
  ".claude.json",
  ".local/share/claude-swap/",
] as const

const CLEAN_TIMEOUT_MS = 60_000
const OUTPUT_MAX_BYTES = 1024 * 1024

// Runs as filer, whose home it is (0700, so node cannot read it). Nothing is followed: a kept name that is
// a symlink, or a directory on the way to one that is a symlink, is deleted like anything else.
// `.claude.json` keeps its account block only; its projects carry per-directory settings and MCP servers.
const CLEAN_HOME = `const fs = require("node:fs")
const path = require("node:path")
const home = process.env.HOME
const keep = JSON.parse(process.argv[1])
const files = new Set(keep.filter((k) => !k.endsWith("/")))
const dirs = new Set(keep.filter((k) => k.endsWith("/")).map((k) => k.slice(0, -1)))
const via = new Set()
for (const k of [...files, ...dirs]) for (let p = path.dirname(k); p !== "."; p = path.dirname(p)) via.add(p)
const say = (line) => console.log(JSON.stringify(line))
function sweep(rel) {
  for (const name of fs.readdirSync(path.join(home, rel))) {
    const r = rel === "" ? name : rel + "/" + name
    const st = fs.lstatSync(path.join(home, r))
    if ((files.has(r) && st.isFile()) || (dirs.has(r) && st.isDirectory())) continue
    if (via.has(r) && st.isDirectory()) { sweep(r); continue }
    fs.rmSync(path.join(home, r), { recursive: true, force: true })
    say({ removed: r })
  }
}
sweep("")
const account = path.join(home, ".claude.json")
if (fs.existsSync(account)) {
  let parsed = null
  try { parsed = JSON.parse(fs.readFileSync(account, "utf8")) } catch {}
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fs.rmSync(account)
    say({ removed: ".claude.json" })
  } else {
    const dropped = Object.keys(parsed).filter((k) => k !== "oauthAccount")
    if (dropped.length > 0) {
      const kept = parsed.oauthAccount === undefined ? {} : { oauthAccount: parsed.oauthAccount }
      fs.writeFileSync(account + ".tmp", JSON.stringify(kept, null, 2), { mode: 0o600 })
      fs.renameSync(account + ".tmp", account)
      for (const key of dropped) say({ removed: ".claude.json#" + key })
    }
  }
}`

/** Empties /home/filer down to CLAUDE_HOME_KEEP before a Claude process starts; logs each removal. */
export async function cleanClaudeHome(runner: FilerRunner, log: FilerLog): Promise<void> {
  const run = await runAsFiler(runner, {
    args: [runner.nodeBinary, "-e", CLEAN_HOME, JSON.stringify(CLAUDE_HOME_KEEP)],
    timeoutMs: CLEAN_TIMEOUT_MS,
    stdoutMaxBytes: OUTPUT_MAX_BYTES,
  })
  for (const line of run.stdout.split("\n")) {
    let removed: unknown
    try {
      removed = (JSON.parse(line) as { removed?: unknown }).removed
    } catch {
      // The empty last line, or one cut off at OUTPUT_MAX_BYTES.
      continue
    }
    if (typeof removed === "string") log("filer: removed from the filer home", { path: removed })
  }
  if (run.exitCode !== 0 || run.timedOut) {
    throw new Error(`the filer home could not be cleaned (exit ${run.exitCode}): ${run.stderrTail}`)
  }
}
