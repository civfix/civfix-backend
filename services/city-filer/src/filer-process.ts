import { spawn as nodeSpawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

/** How filer processes start: through filer-shell, as `filer`, each in its own process group (D7). */
export interface FilerRunner {
  filerShell: string
  /** Resolved by filer-shell's PATH in the image. */
  nodeBinary: string
  kitRunScript: string
  spawn?: typeof nodeSpawn
}

export const IMAGE_RUNNER: FilerRunner = {
  filerShell: "/usr/local/bin/filer-shell",
  nodeBinary: "node",
  kitRunScript: "/app/kit/run-script.mjs",
}

export interface FilerProcessOptions {
  args: readonly string[]
  run?: { dir: string; host: string }
  timeoutMs: number
  /** Empty unless given, so the wrapper's DATABASE_URL and R2 keys never reach filer-shell. */
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Written to the child's stdin, which is closed after it; without it stdin is closed at once. */
  stdin?: string
  onStdoutLine?: (line: string) => void
  /** Keeps stdout whole, up to this many bytes, in the result's `stdout`. */
  stdoutMaxBytes?: number
}

export interface FilerProcessResult {
  exitCode: number | null
  timedOut: boolean
  stderrTail: string
  /** Empty unless `stdoutMaxBytes` was given. */
  stdout: string
  /** The same, as the bytes the child wrote (a git blob is not text). */
  stdoutBytes: Buffer
}

const STDERR_TAIL_CHARS = 2000
const LINE_MAX_CHARS = 4096
// After the leader exits and its group is killed, the pipes close at once unless a process left the
// group holding them; the run does not wait on that one.
const PIPE_CLOSE_GRACE_MS = 2000

const liveGroups = new Set<number>()

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (ignored) {
    // ESRCH: every process of the group has already exited.
    void ignored
  }
}

/** On shutdown: a run killed here ends as a failed attempt its handler still reports. */
export function killAllFilerProcesses(): void {
  for (const pid of liveGroups) killGroup(pid)
}

export function runAsFiler(
  runner: FilerRunner,
  opts: FilerProcessOptions,
): Promise<FilerProcessResult> {
  const runArgs = opts.run === undefined ? [] : ["--run-dir", opts.run.dir, "--host", opts.run.host]
  // filer-shell passes on only what it sets itself; the env is empty unless a caller (the preflight)
  // hands it its own on purpose.
  const child = (runner.spawn ?? nodeSpawn)(runner.filerShell, [...runArgs, "--", ...opts.args], {
    env: opts.env ?? {},
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  // A child that exits without reading its input closes the pipe under the write (EPIPE).
  child.stdin.on("error", () => {})
  child.stdin.end(opts.stdin ?? "")
  let stderr = ""
  let partial = ""
  const decoder = new StringDecoder("utf8")
  const kept: Buffer[] = []
  let keptBytes = 0
  child.stdout.on("data", (chunk: Buffer) => {
    if (opts.stdoutMaxBytes !== undefined && keptBytes < opts.stdoutMaxBytes) {
      const part = chunk.subarray(0, opts.stdoutMaxBytes - keptBytes)
      kept.push(part)
      keptBytes += part.length
    }
    const lines = (partial + decoder.write(chunk)).split("\n")
    partial = (lines.pop() ?? "").slice(-LINE_MAX_CHARS)
    for (const line of lines) opts.onStdoutLine?.(line)
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS)
  })

  return new Promise((resolve, reject) => {
    let timedOut = false
    const pid = child.pid
    if (pid !== undefined) liveGroups.add(pid)
    const timer = setTimeout(() => {
      timedOut = true
      if (pid !== undefined) killGroup(pid)
    }, opts.timeoutMs)
    const closed = new Promise<void>((done) => child.once("close", () => done()))
    child.once("error", (err) => {
      clearTimeout(timer)
      if (pid !== undefined) liveGroups.delete(pid)
      reject(err)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      // Whatever the script left running in its group goes with it.
      if (pid !== undefined) {
        killGroup(pid)
        liveGroups.delete(pid)
      }
      const grace = new Promise<void>((done) => setTimeout(done, PIPE_CLOSE_GRACE_MS).unref())
      void Promise.race([closed, grace]).then(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        if (partial !== "") opts.onStdoutLine?.(partial)
        const stdoutBytes = Buffer.concat(kept)
        resolve({
          exitCode: code,
          timedOut,
          stderrTail: stderr,
          stdout: stdoutBytes.toString("utf8"),
          stdoutBytes,
        })
      })
    })
  })
}
