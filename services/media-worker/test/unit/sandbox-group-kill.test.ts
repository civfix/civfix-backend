import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runTool, SandboxToolError } from "../../src/sandbox/exec.js"

// A decoder that forks keeps its children in the sandbox's process group; a timeout must take the whole
// group down, or a hostile input leaves a process running after its job is gone.

const GONE_WITHIN_MS = 2_000
const POLL_MS = 20

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH"
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (isGone(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return isGone(pid)
}

describe("runTool timeout", () => {
  it("T18: kills the child and the grandchild it forked", async () => {
    dir = await mkdtemp(join(tmpdir(), "sandbox-group-kill-"))
    const err = await runTool(
      "shell",
      "/bin/sh",
      ["-c", "sleep 30 & echo $! > grandchild.pid; echo $$ > child.pid; sleep 30"],
      { timeoutMs: 500, maxStdoutBytes: 65536, cwd: dir },
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SandboxToolError)
    expect((err as SandboxToolError).timedOut).toBe(true)
    const child = Number.parseInt(await readFile(join(dir, "child.pid"), "utf8"), 10)
    const grandchild = Number.parseInt(await readFile(join(dir, "grandchild.pid"), "utf8"), 10)
    expect(Number.isInteger(child)).toBe(true)
    expect(Number.isInteger(grandchild)).toBe(true)
    expect(await goneWithin(child, GONE_WITHIN_MS)).toBe(true)
    expect(await goneWithin(grandchild, GONE_WITHIN_MS)).toBe(true)
  })
})
