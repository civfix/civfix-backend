/**
 * Hardened child-process runner for the sandboxed media tools (ffprobe / ffmpeg).
 *
 * Security posture: untrusted bytes are NEVER interpolated into a shell string. We always invoke the
 * binary directly with an ARGS ARRAY (execa with shell:false), so there is no shell, no glob/quote
 * parsing, and therefore no command-injection surface even if a file path or codec string contained
 * shell metacharacters. Every invocation is bounded by:
 *   - timeout      hard wall-clock; on expiry the child is killed with killSignal.
 *   - killSignal   SIGKILL (non-catchable) so a wedged decoder cannot ignore the kill.
 *   - maxBuffer    cap on stdout+stderr bytes so a chatty/streaming tool cannot exhaust memory.
 * The binary paths come from ffmpeg-static / ffprobe-static (vendored, fixed), never from input.
 *
 * execa is a VENDORED dependency confined to the sandbox/ tree (the seam rule: third-party process
 * machinery stays out of domain code). This module exposes a tiny typed surface so the rest of the
 * worker never imports execa directly.
 */

import { execa, type Options as ExecaOptions } from "execa"
import { CHILD_KILL_SIGNAL } from "../config.js"

export interface RunResult {
  stdout: string
  stderr: string
  /** Raw stdout bytes (for tools whose output is binary, e.g. ffmpeg piping to stdout). */
  stdoutBuffer: Buffer
  exitCode: number
}

export interface RunOptions {
  /** Hard timeout in milliseconds. On expiry the child is SIGKILLed. */
  timeoutMs: number
  /** Max bytes for stdout/stderr (each), to bound memory. */
  maxBuffer: number
  /** When true, capture stdout as a Buffer (binary-safe). Default false (utf8 text). */
  binaryStdout?: boolean
  /** Optional cwd for the child. Defaults to the OS temp dir set by the caller. */
  cwd?: string
}

/** Error thrown when a sandboxed tool fails (non-zero exit, timeout, or spawn failure). */
export class SandboxToolError extends Error {
  readonly tool: string
  readonly timedOut: boolean
  readonly exitCode: number | null
  readonly stderrTail: string

  constructor(
    tool: string,
    opts: { timedOut: boolean; exitCode: number | null; stderrTail: string; cause?: unknown },
  ) {
    super(
      `sandbox tool "${tool}" failed` +
        (opts.timedOut ? " (timed out)" : opts.exitCode !== null ? ` (exit ${opts.exitCode})` : ""),
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    )
    this.name = "SandboxToolError"
    this.tool = tool
    this.timedOut = opts.timedOut
    this.exitCode = opts.exitCode
    this.stderrTail = opts.stderrTail
    Object.setPrototypeOf(this, SandboxToolError.prototype)
  }
}

/** Keep only the last `n` chars of stderr for diagnostics (avoid unbounded log lines). */
function tail(s: string, n = 800): string {
  return s.length <= n ? s : s.slice(s.length - n)
}

/**
 * Run a vendored binary with a fixed args array under hard limits. `name` is a label for errors only.
 * Throws SandboxToolError on timeout / non-zero exit / spawn failure. Never spawns a shell.
 */
export async function runTool(
  name: string,
  binaryPath: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  const execaOpts: ExecaOptions = {
    timeout: opts.timeoutMs,
    killSignal: CHILD_KILL_SIGNAL,
    maxBuffer: opts.maxBuffer,
    // Hard guarantees: never a shell; do not throw raw, we map to SandboxToolError below; do not
    // inherit stdio; strip a trailing newline from text output for stable parsing.
    shell: false,
    reject: false,
    stripFinalNewline: true,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.binaryStdout ? { encoding: "buffer" as const } : {}),
  }

  let result: Awaited<ReturnType<typeof execa>>
  try {
    result = await execa(binaryPath, args as string[], execaOpts)
  } catch (err) {
    // A throw here means a spawn-level failure (binary missing, EACCES, ...): reject:false handles
    // non-zero exits, so this branch is genuinely exceptional.
    throw new SandboxToolError(name, {
      timedOut: false,
      exitCode: null,
      stderrTail: "",
      cause: err,
    })
  }

  const stderrText =
    typeof result.stderr === "string"
      ? result.stderr
      : Buffer.isBuffer(result.stderr)
        ? result.stderr.toString("utf8")
        : ""

  if (result.failed || result.timedOut || (result.exitCode ?? 1) !== 0) {
    throw new SandboxToolError(name, {
      timedOut: Boolean(result.timedOut),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      stderrTail: tail(stderrText),
    })
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
