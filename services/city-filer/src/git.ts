import type { FilerLog } from "./config.js"
import { runAsFiler, type FilerRunner } from "./filer-process.js"

export interface GitDeps {
  runner: FilerRunner
  workspaceDir: string
  log: FilerLog
}

const GIT_TIMEOUT_MS = 60_000
const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024
const CLEAN_PATHS_PER_CALL = 100

/**
 * The only way the wrapper runs git (D7): as filer through filer-shell, with no system or global config,
 * and with the hooks and fsmonitor a filer process could have planted in .git/config switched off. What
 * else .git holds runs with no more than filer's rights. `--literal-pathspecs` keeps a file name Claude
 * chose from reading as pathspec magic or a glob.
 */
function gitArgs(workspaceDir: string, args: readonly string[]): string[] {
  return [
    ...["env", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "git"],
    ...["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"],
    ...["-c", `safe.directory=${workspaceDir}`],
    ...["-c", "user.name=CivFix filer", "-c", "user.email=filer@civfix.invalid"],
    ...["-C", workspaceDir, "--literal-pathspecs"],
    ...args,
  ]
}

async function git(deps: GitDeps, args: readonly string[], stdin?: string): Promise<string> {
  const run = await runAsFiler(deps.runner, {
    args: gitArgs(deps.workspaceDir, args),
    timeoutMs: GIT_TIMEOUT_MS,
    stdoutMaxBytes: GIT_OUTPUT_MAX_BYTES,
    ...(stdin !== undefined ? { stdin } : {}),
  })
  if (run.exitCode !== 0 || run.timedOut) {
    throw new Error(`git ${args[0]} failed (exit ${run.exitCode}): ${run.stderrTail}`)
  }
  return run.stdout
}

const nulList = (out: string): string[] => out.split("\0").filter((p) => p !== "")
const nulJoin = (paths: readonly string[]): string => paths.map((p) => `${p}\0`).join("")
const fromStdin = ["--pathspec-from-file=-", "--pathspec-file-nul"]

export async function workspaceHead(deps: GitDeps): Promise<string> {
  return (await git(deps, ["rev-parse", "--verify", "HEAD"])).trim()
}

/**
 * D8's confinement, after Claude exits: every path under portals/ outside portals/<host>/ that differs from
 * `base` (the HEAD before Claude ran) in a commit, the index, the working tree or as an untracked or
 * ignored file goes back to `base`, in one revert commit, and is logged.
 */
export async function confineToHost(
  deps: GitDeps,
  opts: { base: string; host: string; filingId: string },
): Promise<void> {
  const diff = ["diff", "--name-only", "--no-renames", "--no-ext-diff", "-z"]
  const touched = new Set([
    ...nulList(await git(deps, [...diff, opts.base, "HEAD", "--", "portals/"])),
    ...nulList(await git(deps, [...diff, "--cached", opts.base, "--", "portals/"])),
    ...nulList(await git(deps, [...diff, opts.base, "--", "portals/"])),
    // No --exclude-standard: a .gitignore Claude wrote must not hide what it added.
    ...nulList(await git(deps, ["ls-files", "--others", "-z", "--", "portals/"])),
  ])
  const outside = [...touched].filter((p) => !p.startsWith(`portals/${opts.host}/`)).sort()
  if (outside.length === 0) return

  const inBase = new Set(
    nulList(await git(deps, ["ls-tree", "-r", "-z", "--name-only", opts.base, "--", "portals/"])),
  )
  const added = outside.filter((p) => !inBase.has(p))
  const changed = outside.filter((p) => inBase.has(p))
  if (added.length > 0) {
    await git(
      deps,
      ["rm", "-r", "-q", "--cached", "--ignore-unmatch", ...fromStdin],
      nulJoin(added),
    )
    for (let i = 0; i < added.length; i += CLEAN_PATHS_PER_CALL) {
      // -f twice also removes a nested repository.
      const chunk = added.slice(i, i + CLEAN_PATHS_PER_CALL)
      await git(deps, ["clean", "-f", "-f", "-d", "-x", "-q", "--", ...chunk])
    }
  }
  if (changed.length > 0) {
    await git(deps, ["checkout", opts.base, ...fromStdin], nulJoin(changed))
  }
  // Only the reverted paths are committed: Claude's staged work on its own host stays as it left it.
  const staged = new Set(nulList(await git(deps, [...diff, "--cached", "HEAD", "--", "portals/"])))
  const commit = outside.filter((p) => staged.has(p))
  if (commit.length > 0) {
    await git(
      deps,
      [
        ...["commit", "-q", "--no-verify", "--no-gpg-sign"],
        ...["-m", `Revert out-of-scope changes (filing ${opts.filingId})`, ...fromStdin],
      ],
      nulJoin(commit),
    )
  }
  for (const path of outside) {
    deps.log("filer: reverted an out-of-scope change", { filingId: opts.filingId, path })
  }
}
