import { createHash } from "node:crypto"
import { lstat, readdir, readlink, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { FilerLog } from "./config.js"
import { runAsFiler, type FilerRunner } from "./filer-process.js"
import { forgetProved } from "./proved.js"
import { readContainedFile } from "./safe-file.js"
import { isPortalHost } from "./script.js"

export interface GitDeps {
  runner: FilerRunner
  workspaceDir: string
  log: FilerLog
}

const GIT_TIMEOUT_MS = 60_000
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024
const FILE_MAX_BYTES = 8 * 1024 * 1024
const RESTORE_TIMEOUT_MS = 60_000

/**
 * The only way the wrapper runs git (D7): as filer through filer-shell, with no system or global config,
 * the hooks and fsmonitor a filer process could have planted in .git/config switched off, and the
 * repository and work tree named outright, so a planted `core.worktree` points nowhere. What else .git
 * holds runs with no more than filer's rights, and confinement trusts none of it (`confineToHost`).
 * `--literal-pathspecs` keeps a file name Claude chose from reading as pathspec magic or a glob.
 */
function gitArgs(workspaceDir: string, args: readonly string[]): string[] {
  return [
    ...["env", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "git"],
    ...["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"],
    ...["-c", `safe.directory=${workspaceDir}`],
    ...["-c", "user.name=CivFix filer", "-c", "user.email=filer@civfix.invalid"],
    ...[`--git-dir=${join(workspaceDir, ".git")}`, `--work-tree=${workspaceDir}`],
    ...["-C", workspaceDir, "--literal-pathspecs", "--no-replace-objects"],
    ...args,
  ]
}

async function git(deps: GitDeps, args: readonly string[], stdin?: string): Promise<Buffer> {
  const run = await runAsFiler(deps.runner, {
    args: gitArgs(deps.workspaceDir, args),
    timeoutMs: GIT_TIMEOUT_MS,
    stdoutMaxBytes: GIT_OUTPUT_MAX_BYTES,
    ...(stdin !== undefined ? { stdin } : {}),
  })
  if (run.exitCode !== 0 || run.timedOut) {
    throw new Error(`git ${args[0]} failed (exit ${run.exitCode}): ${run.stderrTail}`)
  }
  return run.stdoutBytes
}

export async function workspaceHead(deps: GitDeps): Promise<string> {
  return (await git(deps, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim()
}

interface BaseEntry {
  mode: string
  oid: string
}

/** What a path holds: a blob id for a file or symlink, or "odd" for anything that can't be compared. */
type DiskEntry = { kind: "file" | "symlink"; oid: string } | { kind: "odd" }

const SYMLINK_MODE = "120000"
const FILE_MODES = new Set(["100644", "100755"])

/** The base commit's tree under portals/ as git stores it; no index, work tree or filter is read. */
async function baseTree(deps: GitDeps, base: string): Promise<Map<string, BaseEntry>> {
  const out = await git(deps, ["ls-tree", "-r", "-z", base, "--", "portals/"])
  const entries = new Map<string, BaseEntry>()
  for (const record of out.toString("utf8").split("\0")) {
    if (record === "") continue
    const tab = record.indexOf("\t")
    const [mode = "", , oid = ""] = record.slice(0, tab).split(" ")
    // A gitlink or anything but a file or symlink can't be put back, so it counts as not in base.
    if (mode === SYMLINK_MODE || FILE_MODES.has(mode))
      entries.set(record.slice(tab + 1), { mode, oid })
  }
  return entries
}

/** Git's id of a blob with these bytes, in the repository's hash (sha1, or sha256 for 64 hex). */
function blobId(bytes: Buffer, oidLength: number): string {
  const hash = createHash(oidLength === 64 ? "sha256" : "sha1")
  return hash.update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

/**
 * Every path under portals/ outside portals/<host>/ as node reads it from disk, never through git: a
 * symlink is not followed, and a file is read only where it really sits (`readContainedFile`). A
 * directory node cannot list, a special file or an oversized one is "odd", which never matches base.
 */
async function diskTree(
  workspaceDir: string,
  host: string,
  oidLength: number,
): Promise<Map<string, DiskEntry>> {
  const realWorkspace = await realpath(workspaceDir)
  const entries = new Map<string, DiskEntry>()
  async function walk(rel: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(join(workspaceDir, rel))
    } catch {
      entries.set(rel, { kind: "odd" })
      return
    }
    for (const name of names) {
      const path = `${rel}/${name}`
      if (path === `portals/${host}`) continue
      const st = await lstat(join(workspaceDir, path))
      if (st.isDirectory()) {
        await walk(path)
      } else if (st.isSymbolicLink()) {
        const target = Buffer.from(await readlink(join(workspaceDir, path), { encoding: "buffer" }))
        entries.set(path, { kind: "symlink", oid: blobId(target, oidLength) })
      } else {
        const read = await readContainedFile(join(workspaceDir, path), {
          maxBytes: FILE_MAX_BYTES,
          parentDir: join(realWorkspace, rel),
        })
        entries.set(
          path,
          read.kind === "ok"
            ? { kind: "file", oid: blobId(read.bytes, oidLength) }
            : { kind: "odd" },
        )
      }
    }
  }
  await walk("portals")
  return entries
}

/** The paths outside portals/<host>/ whose bytes on disk are not base's, sorted. */
function changedPaths(
  base: Map<string, BaseEntry>,
  disk: Map<string, DiskEntry>,
  host: string,
): string[] {
  const changed: string[] = []
  for (const path of new Set([...base.keys(), ...disk.keys()])) {
    if (path.startsWith(`portals/${host}/`)) continue
    const want = base.get(path)
    const have = disk.get(path)
    const kind = want === undefined ? null : want.mode === SYMLINK_MODE ? "symlink" : "file"
    const same =
      want !== undefined && have !== undefined && have.kind === kind && have.oid === want.oid
    if (!same) changed.push(path)
  }
  return changed.sort()
}

/** `git cat-file --batch`'s answer: each blob's bytes by id. */
function parseBatch(out: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>()
  let at = 0
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at)
    const [oid = "", type, size] = out.subarray(at, eol).toString("utf8").split(" ")
    if (type !== "blob" || size === undefined) throw new Error(`git cat-file: ${oid} is ${type}`)
    const start = eol + 1
    blobs.set(oid, out.subarray(start, start + Number(size)))
    at = start + Number(size) + 1
  }
  return blobs
}

// Runs as filer, which owns portals/: removes what base lacks, then writes base's bytes back, replacing
// whatever stands at a path or on the way to it. Nothing it writes is read back without the byte check.
const RESTORE = `const fs = require("node:fs")
const path = require("node:path")
const workspace = process.argv[1]
const clear = (abs) => fs.rmSync(abs, { recursive: true, force: true })
for (const op of JSON.parse(fs.readFileSync(0, "utf8"))) {
  const abs = path.join(workspace, op.path)
  if (op.op === "rm") { clear(abs); continue }
  let dir = workspace
  for (const part of path.dirname(op.path).split("/")) {
    dir = path.join(dir, part)
    const st = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (st !== undefined && !st.isDirectory()) clear(dir)
    if (st === undefined || !st.isDirectory()) fs.mkdirSync(dir)
  }
  if (fs.lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) clear(abs)
  const tmp = abs + ".civfix-restore"
  clear(tmp)
  if (op.op === "link") fs.symlinkSync(op.target, tmp)
  else fs.writeFileSync(tmp, Buffer.from(op.b64, "base64"), { mode: op.exec ? 0o770 : 0o660 })
  fs.renameSync(tmp, abs)
}`

async function restore(
  deps: GitDeps,
  base: Map<string, BaseEntry>,
  changed: readonly string[],
): Promise<void> {
  const back = changed.filter((p) => base.has(p))
  const oids = [...new Set(back.map((p) => base.get(p)?.oid ?? ""))]
  const blobs =
    oids.length === 0
      ? new Map<string, Buffer>()
      : parseBatch(await git(deps, ["cat-file", "--batch"], oids.map((oid) => `${oid}\n`).join("")))
  const ops = [
    ...changed.filter((p) => !base.has(p)).map((path) => ({ op: "rm", path })),
    ...back.map((path) => {
      const { mode, oid } = base.get(path) ?? { mode: "", oid: "" }
      const bytes = blobs.get(oid) ?? Buffer.alloc(0)
      return mode === SYMLINK_MODE
        ? { op: "link", path, target: bytes.toString("utf8") }
        : { op: "write", path, b64: bytes.toString("base64"), exec: mode === "100755" }
    }),
  ]
  const run = await runAsFiler(deps.runner, {
    args: [deps.runner.nodeBinary, "-e", RESTORE, deps.workspaceDir],
    stdin: JSON.stringify(ops),
    timeoutMs: RESTORE_TIMEOUT_MS,
  })
  if (run.exitCode !== 0 || run.timedOut) {
    throw new Error(`restoring portals/ failed (exit ${run.exitCode}): ${run.stderrTail}`)
  }
}

/**
 * The revert commit, made with plumbing alone so no hook, filter or attribute runs: HEAD's tree with the
 * reverted paths set back to base. Claude's process group is dead by now, so any index.lock is stale.
 */
async function commitRevert(
  deps: GitDeps,
  base: Map<string, BaseEntry>,
  changed: readonly string[],
  filingId: string,
): Promise<void> {
  const lock = join(deps.workspaceDir, ".git", "index.lock")
  const rm = await runAsFiler(deps.runner, {
    args: ["rm", "-f", "--", lock],
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (rm.exitCode !== 0)
    throw new Error(`a stale index.lock could not be removed: ${rm.stderrTail}`)
  const head = await workspaceHead(deps)
  const zero = "0".repeat(head.length)
  await git(deps, ["read-tree", head])
  const entries = changed.map((path) => {
    const want = base.get(path)
    return want === undefined ? `0 ${zero}\t${path}\0` : `${want.mode} ${want.oid}\t${path}\0`
  })
  await git(deps, ["update-index", "-z", "--index-info"], entries.join(""))
  const tree = (await git(deps, ["write-tree"])).toString("utf8").trim()
  const message = [`Revert out-of-scope changes (filing ${filingId})`, changed.join("\n")]
  const commit = (
    await git(deps, [
      "commit-tree",
      "--no-gpg-sign",
      "-p",
      head,
      "-m",
      message[0] ?? "",
      "-m",
      message[1] ?? "",
      tree,
    ])
  )
    .toString("utf8")
    .trim()
  await git(deps, ["update-ref", "-m", message[0] ?? "", "HEAD", commit, head])
}

/**
 * The proved records a changed path can make stale: its host's, for a path inside one host's folder, and
 * every record for anything else (portals/ itself, a file directly in it, or portals/node_modules/, which
 * node's module resolution searches for every host's imports).
 */
function affectedHosts(paths: readonly string[]): string[] | "all" {
  const hosts = new Set<string>()
  for (const path of paths) {
    const [, host = "", ...rest] = path.split("/")
    if (rest.length === 0 || host === "node_modules" || !isPortalHost(host)) return "all"
    hosts.add(host)
  }
  return [...hosts]
}

/** Deletes the records `hosts` names, then rethrows `err`; a record that can't be deleted is in the error. */
async function failClosed(
  deps: GitDeps,
  hosts: readonly string[] | "all",
  why: string,
  err: unknown,
): Promise<never> {
  try {
    await forgetProved(deps.workspaceDir, hosts, deps.log, why)
  } catch (forgetErr) {
    throw new AggregateError([err, forgetErr], `confinement failed (${why})`)
  }
  throw err
}

/**
 * D8's confinement, after Claude exits. A change is found by comparing the bytes on disk under portals/
 * with `base`'s blobs (the HEAD before Claude ran), so nothing filer controls in .git (the index and its
 * flags, the stat cache, attributes, filters, core.worktree) can hide one. Every path outside
 * portals/<host>/ that differs goes back to base, in one revert commit, and is logged. Fails closed: every
 * record a change that could not be put back may have made stale is deleted (`affectedHosts`), so no
 * script runs live unproved.
 * False when a path still differs after the revert.
 */
export async function confineToHost(
  deps: GitDeps,
  opts: { base: string; host: string; filingId: string },
): Promise<boolean> {
  const compare = async (base: Map<string, BaseEntry>) => {
    const oidLength = opts.base.length
    return changedPaths(base, await diskTree(deps.workspaceDir, opts.host, oidLength), opts.host)
  }
  let base: Map<string, BaseEntry>
  let changed: string[]
  try {
    base = await baseTree(deps, opts.base)
    changed = await compare(base)
  } catch (err) {
    return failClosed(deps, "all", "the confinement check failed", err)
  }
  if (changed.length === 0) return true
  try {
    await restore(deps, base, changed)
    await commitRevert(deps, base, changed, opts.filingId)
  } catch (err) {
    return failClosed(deps, affectedHosts(changed), "an out-of-scope change was not reverted", err)
  }
  for (const path of changed) {
    deps.log("filer: reverted an out-of-scope change", { filingId: opts.filingId, path })
  }
  let still: string[]
  try {
    still = await compare(base)
  } catch (err) {
    return failClosed(deps, "all", "the confinement check failed", err)
  }
  for (const path of still) {
    deps.log("filer: an out-of-scope change survived the revert", { filingId: opts.filingId, path })
  }
  if (still.length === 0) return true
  await forgetProved(
    deps.workspaceDir,
    affectedHosts(still),
    deps.log,
    "an out-of-scope change survived",
  )
  return false
}
