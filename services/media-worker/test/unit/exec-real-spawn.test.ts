
import { describe, expect, it } from "vitest"
import { runTool, SandboxSpawnError, SandboxToolError } from "../../src/sandbox/exec.js"

const OPTS = { timeoutMs: 5_000, maxStdoutBytes: 64 * 1024 }

async function run(args: string[]): Promise<unknown> {
  return runTool("shell", "/bin/sh", args, OPTS).catch((err: unknown) => err)
}

describe("runTool classification against real children", () => {
  it("a SIGSEGV death is a verdict on the input, not an infra fault", async () => {
    const err = await run(["-c", "kill -SEGV $$"])

    expect(err).toBeInstanceOf(SandboxToolError)
    expect(err).not.toBeInstanceOf(SandboxSpawnError)
    expect((err as SandboxToolError).signal).toBe("SIGSEGV")
    expect(String(err)).toContain("SIGSEGV")
  })

  it("a SIGABRT death is a verdict too", async () => {
    const err = await run(["-c", "kill -ABRT $$"])
    expect(err).toBeInstanceOf(SandboxToolError)
    expect((err as SandboxToolError).signal).toBe("SIGABRT")
  })

  it("a SIGKILL death (the OOM killer's signal) is a verdict too", async () => {
    const err = await run(["-c", "kill -KILL $$"])
    expect(err).toBeInstanceOf(SandboxToolError)
    expect(err).not.toBeInstanceOf(SandboxSpawnError)
    expect((err as SandboxToolError).signal).toBe("SIGKILL")
  })

  it("a non-zero exit stays a verdict", async () => {
    const err = await run(["-c", "exit 1"])
    expect(err).toBeInstanceOf(SandboxToolError)
    expect((err as SandboxToolError).exitCode).toBe(1)
    expect((err as SandboxToolError).signal).toBeNull()
  })

  it("a missing binary IS an infra fault", async () => {
    const err = await runTool(
      "missing",
      "/nonexistent/civfix/decoder",
      ["-version"],
      OPTS,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SandboxSpawnError)
  })

  it("a success still returns stdout", async () => {
    const res = await runTool("shell", "/bin/sh", ["-c", "echo hello"], OPTS)
    expect(res.stdout).toBe("hello")
    expect(res.exitCode).toBe(0)
  })

  it("kills the whole process group, so a forked survivor cannot outlive the job", async () => {
    const res = await runTool(
      "shell",
      "/bin/sh",
      ["-c", "sleep 30 >/dev/null 2>&1 & echo $! ; exit 0"],
      OPTS,
    )
    const survivor = Number.parseInt(res.stdout.trim(), 10)
    expect(Number.isInteger(survivor)).toBe(true)

    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(survivor, 0)
        await new Promise((resolve) => setTimeout(resolve, 20))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  })

  it("B4: a survivor holding the stdio pipes does NOT stall the call", async () => {
    const started = Date.now()

    const res = await runTool("shell", "/bin/sh", ["-c", "sleep 30 & exit 0"], OPTS)

    expect(res.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("B4: the per-tool timeout is real even when children hold the pipes", async () => {
    const started = Date.now()

    const err = await runTool("shell", "/bin/sh", ["-c", "sleep 30 & sleep 30"], {
      timeoutMs: 500,
      maxStdoutBytes: 64 * 1024,
    }).catch((e: unknown) => e)
    const elapsed = Date.now() - started

    expect(err).toBeInstanceOf(SandboxToolError)
    expect(elapsed).toBeLessThan(5_000)
  })

  it("caps what the parent will buffer from a lane, and treats the overflow as a verdict", async () => {
    const err = await runTool("shell", "/bin/sh", ["-c", "yes civfix | head -c 200000"], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SandboxToolError)
    expect(err).not.toBeInstanceOf(SandboxSpawnError)
  })

  it("still returns output under the cap", async () => {
    const res = await runTool("shell", "/bin/sh", ["-c", "echo small"], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
    })
    expect(res.stdout).toBe("small")
  })
})
