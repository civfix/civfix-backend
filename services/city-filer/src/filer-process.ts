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

export interface FilerProcessOptions {
  args: readonly string[]
  run: { dir: string; host: string }
  timeoutMs: number
  cwd: string
  onStdoutLine: (line: string) => void
}

export interface FilerProcessResult {
  exitCode: number | null
  timedOut: boolean
}

const LINE_MAX_CHARS = 4096
// After the leader exits and its group is killed, the pipe closes at once unless a process left the
// group holding it; the run does not wait on that one.
const PIPE_CLOSE_GRACE_MS = 2000

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (ignored) {
    // ESRCH: every process of the group has already exited.
    void ignored
  }
}

export function runAsFiler(
  runner: FilerRunner,
  opts: FilerProcessOptions,
): Promise<FilerProcessResult> {
  const runArgs = ["--run-dir", opts.run.dir, "--host", opts.run.host]
  // An empty env, so the wrapper's DATABASE_URL and R2 keys never reach filer-shell, which passes on
  // only what it sets itself.
  const child = (runner.spawn ?? nodeSpawn)(runner.filerShell, [...runArgs, "--", ...opts.args], {
    env: {},
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
  let partial = ""
  const decoder = new StringDecoder("utf8")
  child.stdout.on("data", (chunk: Buffer) => {
    const lines = (partial + decoder.write(chunk)).split("\n")
    partial = (lines.pop() ?? "").slice(-LINE_MAX_CHARS)
    for (const line of lines) opts.onStdoutLine(line)
  })

  return new Promise((resolve, reject) => {
    let timedOut = false
    const pid = child.pid
    const timer = setTimeout(() => {
      timedOut = true
      if (pid !== undefined) killGroup(pid)
    }, opts.timeoutMs)
    const closed = new Promise<void>((done) => child.once("close", () => done()))
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      // Whatever the script left running in its group goes with it.
      if (pid !== undefined) killGroup(pid)
      const grace = new Promise<void>((done) => setTimeout(done, PIPE_CLOSE_GRACE_MS).unref())
      void Promise.race([closed, grace]).then(() => {
        child.stdout.destroy()
        if (partial !== "") opts.onStdoutLine(partial)
        resolve({ exitCode: code, timedOut })
      })
    })
  })
}
