import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { execa, type Options as ExecaOptions } from "execa"
import {
  CHILD_KILL_SIGNAL,
  loadSandboxIdentity,
  parseBool,
  type SandboxIdentity,
} from "../config.js"

const STDERR_TAIL_CHARS = 800
const SANDBOX_LOCALE = "C"

export interface RunResult {
  stdout: string
  stderr: string
  stdoutBuffer: Buffer
  exitCode: number
}

export interface RunOptions {
  timeoutMs: number
  maxStdoutBytes: number
  binaryStdout?: boolean
  cwd?: string
  identity?: SandboxIdentity | null
}

export class SandboxSpawnError extends Error {
  readonly tool: string

  constructor(tool: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause)
    super(`sandbox tool "${tool}" could not be started${detail ? `: ${detail}` : ""}`, { cause })
    this.name = "SandboxSpawnError"
    this.tool = tool
    Object.setPrototypeOf(this, SandboxSpawnError.prototype)
  }
}

function isSpawnSyscallFailure(err: unknown): boolean {
  const syscall = (err as { syscall?: unknown } | null)?.syscall
  return typeof syscall === "string" && syscall.startsWith("spawn")
}

export class SandboxToolError extends Error {
  readonly tool: string
  readonly timedOut: boolean
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stderrTail: string

  constructor(
    tool: string,
    opts: {
      timedOut: boolean
      exitCode: number | null
      signal?: string | null
      stderrTail: string
      cause?: unknown
    },
  ) {
    const signal = opts.signal ?? null
    super(
      `sandbox tool "${tool}" failed` +
        (opts.timedOut
          ? " (timed out)"
          : signal !== null
            ? ` (killed by ${signal})`
            : opts.exitCode !== null
              ? ` (exit ${opts.exitCode})`
              : ""),
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    )
    this.name = "SandboxToolError"
    this.tool = tool
    this.timedOut = opts.timedOut
    this.exitCode = opts.exitCode
    this.signal = signal
    this.stderrTail = opts.stderrTail
    Object.setPrototypeOf(this, SandboxToolError.prototype)
  }
}

export const SETPRIV_BINARY = "/usr/bin/setpriv"

export function sandboxArgv(
  binaryPath: string,
  args: readonly string[],
  identity: SandboxIdentity | null,
  dropBounding = false,
): { command: string; argv: string[] } {
  if (identity === null) return { command: binaryPath, argv: [...args] }
  return {
    command: SETPRIV_BINARY,
    argv: [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--clear-groups",
      ...(dropBounding ? ["--bounding-set=-all"] : []),
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
      binaryPath,
      ...args,
    ],
  }
}

let cachedIdentity: SandboxIdentity | null | undefined

export function sandboxIdentity(source?: NodeJS.ProcessEnv): SandboxIdentity | null {
  if (source !== undefined && source !== process.env) return loadSandboxIdentity(source)
  cachedIdentity ??= loadSandboxIdentity()
  return cachedIdentity
}

export function resetSandboxIdentity(): void {
  cachedIdentity = undefined
  cachedDropBounding = undefined
}

let cachedDropBounding: boolean | undefined

export function dropBoundingSet(source?: NodeJS.ProcessEnv): boolean {
  if (source !== undefined && source !== process.env) return parseDropBounding(source)
  cachedDropBounding ??= parseDropBounding(process.env)
  return cachedDropBounding
}

function parseDropBounding(source: NodeJS.ProcessEnv): boolean {
  return parseBool(source.MEDIA_SANDBOX_DROP_BOUNDING, false)
}

export function sandboxEnv(binaryPath: string, cwd: string): Record<string, string> {
  return {
    PATH: dirname(binaryPath),
    HOME: cwd,
    TMPDIR: cwd,
    LANG: SANDBOX_LOCALE,
  }
}

const liveSandboxChildren = new Set<number>()

function trackSandboxChild(pid: number | undefined): () => void {
  if (pid === undefined) return () => {}
  liveSandboxChildren.add(pid)
  return () => liveSandboxChildren.delete(pid)
}

export function killAllSandboxChildren(): void {
  for (const pid of liveSandboxChildren) killProcessGroup(pid)
  liveSandboxChildren.clear()
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return
  try {
    process.kill(-pid, CHILD_KILL_SIGNAL)
  } catch (ignored) {
    // ESRCH: the group already exited, which is the state this call exists to reach.
    void ignored
  }
}

function tail(s: string, n = STDERR_TAIL_CHARS): string {
  return s.length <= n ? s : s.slice(s.length - n)
}

export async function runTool(
  name: string,
  binaryPath: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  const cwd = opts.cwd ?? tmpdir()
  const identity = opts.identity === undefined ? sandboxIdentity() : opts.identity
  const spawned = sandboxArgv(binaryPath, args, identity, dropBoundingSet())
  const execaOpts: ExecaOptions = {
    timeout: opts.timeoutMs,
    killSignal: CHILD_KILL_SIGNAL,
    maxBuffer: opts.maxStdoutBytes,
    shell: false,
    reject: false,
    stripFinalNewline: true,
    cwd,
    stdin: "ignore",
    extendEnv: false,
    env: sandboxEnv(binaryPath, cwd),
    detached: true,
    ...(opts.binaryStdout ? { encoding: "buffer" as const } : {}),
  }

  let result: ToolResult
  const subprocess = execa(spawned.command, spawned.argv, execaOpts)
  const leaderPid = typeof subprocess.pid === "number" ? subprocess.pid : undefined
  const cleanup = trackSandboxChild(leaderPid)
  let killTimer: ReturnType<typeof setTimeout> | undefined
  if (leaderPid !== undefined) {
    if (typeof subprocess.once === "function") {
      subprocess.once("exit", () => killProcessGroup(leaderPid))
    }
    killTimer = setTimeout(() => killProcessGroup(leaderPid), opts.timeoutMs)
    killTimer.unref?.()
  }
  try {
    result = await subprocess
  } catch (err) {
    throw new SandboxSpawnError(name, err)
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer)
    killProcessGroup(leaderPid)
    cleanup()
  }

  const stderrText = outputText(result.stderr)
  if (result.failed || result.timedOut || (result.exitCode ?? 1) !== 0) {
    throw toolFailure(name, result, leaderPid, stderrText)
  }

  const stdoutBuffer = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(String(result.stdout ?? ""), "utf8")
  const stdoutText =
    typeof result.stdout === "string" ? result.stdout : stdoutBuffer.toString("utf8")

  return {
    stdout: stdoutText,
    stderr: stderrText,
    stdoutBuffer,
    exitCode: result.exitCode ?? 0,
  }
}

type ToolResult = Awaited<ReturnType<typeof execa>>

function outputText(output: ToolResult["stderr"]): string {
  if (typeof output === "string") return output
  return Buffer.isBuffer(output) ? output.toString("utf8") : ""
}

// A tool that never started says nothing about the bytes (infra, retried); one that ran and died is a
// verdict on them. With no exit code, a missing pid or a spawn-syscall failure counts as "never started".
function toolFailure(
  name: string,
  result: ToolResult,
  leaderPid: number | undefined,
  stderrText: string,
): SandboxSpawnError | SandboxToolError {
  const failure = result as {
    signal?: string
    isTerminated?: boolean
    isMaxBuffer?: boolean
    cause?: unknown
  }
  const signal = typeof failure.signal === "string" ? failure.signal : null
  const ranAndDied =
    signal !== null || failure.isTerminated === true || failure.isMaxBuffer === true
  const neverRan =
    !result.timedOut &&
    !ranAndDied &&
    typeof result.exitCode !== "number" &&
    (leaderPid === undefined || isSpawnSyscallFailure(failure.cause))
  if (neverRan) {
    return new SandboxSpawnError(name, failure.cause ?? tail(stderrText))
  }
  return new SandboxToolError(name, {
    timedOut: Boolean(result.timedOut),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    signal,
    stderrTail: tail(stderrText),
  })
}
