
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const execaMock = vi.fn()
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}))

import {
  runTool,
  resetSandboxIdentity,
  sandboxEnv,
  sandboxArgv,
  SandboxSpawnError,
  SandboxToolError,
  SETPRIV_BINARY,
} from "../../src/sandbox/exec.js"
import { loadImageLaneEntry } from "../../src/config.js"
import { resolveMediaToolPaths, resetMediaToolPaths } from "../../src/sandbox/binaries.js"
import { assertSandboxPreflight } from "../../src/sandbox/preflight.js"
import { loadSandboxIdentity } from "../../src/config.js"

function resolvedSubprocess(result: Record<string, unknown>, pid?: number): unknown {
  const promise = Promise.resolve(result) as Promise<unknown> & {
    pid?: number
    once?: (event: string, listener: () => void) => void
  }
  if (pid !== undefined) promise.pid = pid
  promise.once = () => {}
  return promise
}

const SECRET_KEYS = ["DATABASE_URL", "R2_SECRET_ACCESS_KEY", "CF_TURNSTILE_SECRET", "GLITCHTIP_DSN"]

function envSnapshot(): NodeJS.ProcessEnv {
  return { ...process.env }
}

let saved: NodeJS.ProcessEnv

beforeEach(() => {
  saved = envSnapshot()
  execaMock.mockReset()
  execaMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, failed: false, timedOut: false })
  resetSandboxIdentity()
  resetMediaToolPaths()
})

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  resetSandboxIdentity()
  resetMediaToolPaths()
})

async function spawnCall(): Promise<[string, string[], Record<string, unknown>]> {
  await runTool("ffprobe", "/opt/ffmpeg/bin/ffprobe", ["-version"], {
    timeoutMs: 1000,
    maxStdoutBytes: 1024,
    cwd: "/tmp/civfix-media-test",
  })
  return execaMock.mock.calls[0] as [string, string[], Record<string, unknown>]
}

async function spawnOptions(): Promise<Record<string, unknown>> {
  return (await spawnCall())[2]
}

describe("H7: the decoder child inherits nothing", () => {
  it("spawns with extendEnv:false and an env carrying no credentials", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@db/civfix"
    process.env.R2_SECRET_ACCESS_KEY = "super-secret"
    process.env.CF_TURNSTILE_SECRET = "turnstile"
    process.env.GLITCHTIP_DSN = "https://dsn"

    const opts = await spawnOptions()

    expect(opts.extendEnv).toBe(false)
    expect(opts.stdin).toBe("ignore")
    expect(opts.shell).toBe(false)
    expect(opts.cwd).toBe("/tmp/civfix-media-test")
    const env = opts.env as Record<string, string>
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"])
    expect(env.PATH).toBe("/opt/ffmpeg/bin")
    expect(env.HOME).toBe("/tmp/civfix-media-test")
    for (const key of SECRET_KEYS) expect(env[key]).toBeUndefined()
  })

  it("keeps the env minimal for any binary directory", () => {
    const env = sandboxEnv("/usr/local/bin/ffmpeg", "/tmp/job")
    expect(env).toEqual({ PATH: "/usr/local/bin", HOME: "/tmp/job", TMPDIR: "/tmp/job", LANG: "C" })
  })

  it("B1: launches the decoder through setpriv, never through spawn's uid/gid", async () => {
    process.env.MEDIA_SANDBOX_UID = "1001"
    process.env.MEDIA_SANDBOX_GID = "1001"
    resetSandboxIdentity()

    const [command, argv, opts] = await spawnCall()

    expect(opts.uid).toBeUndefined()
    expect(opts.gid).toBeUndefined()
    expect(command).toBe(SETPRIV_BINARY)
    expect(argv.slice(0, argv.indexOf("--"))).toEqual([
      "--reuid=1001",
      "--regid=1001",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
    ])
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["/opt/ffmpeg/bin/ffprobe", "-version"])
  })

  it("B1: drops the bounding set too when MEDIA_SANDBOX_DROP_BOUNDING is on", () => {
    const { argv } = sandboxArgv("/opt/ffmpeg/bin/ffprobe", ["-i"], { uid: 1001, gid: 1001 }, true)
    expect(argv).toContain("--bounding-set=-all")
  })

  it("spawns the binary directly when no sandbox identity is configured (dev/darwin)", async () => {
    delete process.env.MEDIA_SANDBOX_UID
    delete process.env.MEDIA_SANDBOX_GID
    resetSandboxIdentity()

    const [command, argv, opts] = await spawnCall()

    expect(command).toBe("/opt/ffmpeg/bin/ffprobe")
    expect(argv).toEqual(["-version"])
    expect(opts.uid).toBeUndefined()
    expect(opts.gid).toBeUndefined()
  })
})

describe("H7: MEDIA_SANDBOX_UID/GID are required in production", () => {
  it("throws when production leaves them unset", () => {
    expect(() => loadSandboxIdentity({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /MEDIA_SANDBOX_UID/,
    )
  })

  it("throws when only one of the pair is set, in any environment", () => {
    expect(() =>
      loadSandboxIdentity({ MEDIA_SANDBOX_UID: "1001" } as NodeJS.ProcessEnv),
    ).toThrow(/must be set together/)
  })

  it("returns null outside production when neither is set", () => {
    expect(loadSandboxIdentity({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeNull()
  })

  it("refuses a production boot with no sandbox identity", async () => {
    await expect(
      assertSandboxPreflight({
        NODE_ENV: "production",
        FFMPEG_PATH: "/usr/local/bin/ffmpeg",
        FFPROBE_PATH: "/usr/local/bin/ffprobe",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow()
  })

  it("is a no-op outside production", async () => {
    await expect(
      assertSandboxPreflight({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).resolves.toBeUndefined()
  })
})

describe("B3'': a decoder that could not be STARTED is infra, not a verdict on the bytes", () => {
  async function run(): Promise<unknown> {
    return runTool("ffprobe", "/opt/ffmpeg/bin/ffprobe", ["-version"], {
      timeoutMs: 1000,
      maxStdoutBytes: 1024,
    }).catch((err: unknown) => err)
  }

  it("classifies an execa spawn throw as SandboxSpawnError", async () => {
    execaMock.mockRejectedValue(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))
    expect(await run()).toBeInstanceOf(SandboxSpawnError)
  })

  it("B5: classifies a resolved spawn failure (EAGAIN from the pids limit) as SandboxSpawnError", async () => {
    execaMock.mockReturnValue(
      resolvedSubprocess({
        stdout: "",
        stderr: "",
        failed: true,
        timedOut: false,
        isTerminated: false,
        exitCode: undefined,
        signal: undefined,
        cause: Object.assign(new Error("spawn EAGAIN"), {
          code: "EAGAIN",
          syscall: "spawn /opt/ffmpeg/bin/ffprobe",
        }),
      }),
    )
    expect(await run()).toBeInstanceOf(SandboxSpawnError)
  })

  it("B5: classifies an ENOENT spawn failure the same way", async () => {
    execaMock.mockReturnValue(
      resolvedSubprocess({
        stdout: "",
        stderr: "",
        failed: true,
        timedOut: false,
        isTerminated: false,
        exitCode: undefined,
        signal: undefined,
        cause: Object.assign(new Error("spawn ENOENT"), {
          code: "ENOENT",
          syscall: "spawn /opt/ffmpeg/bin/ffprobe",
        }),
      }),
    )
    expect(await run()).toBeInstanceOf(SandboxSpawnError)
  })

  it("B5: a SIGNAL death with a live pid stays a verdict, never an infra fault", async () => {
    execaMock.mockReturnValue(
      resolvedSubprocess(
        {
          stdout: "",
          stderr: "",
          failed: true,
          timedOut: false,
          isTerminated: true,
          exitCode: undefined,
          signal: "SIGSEGV",
        },
        4242,
      ),
    )
    const err = await run()
    expect(err).toBeInstanceOf(SandboxToolError)
    expect(err).not.toBeInstanceOf(SandboxSpawnError)
    expect((err as SandboxToolError).signal).toBe("SIGSEGV")
  })

  it("B5: an over-large output is a verdict too", async () => {
    execaMock.mockReturnValue(
      resolvedSubprocess(
        {
          stdout: "",
          stderr: "",
          failed: true,
          timedOut: false,
          isTerminated: false,
          isMaxBuffer: true,
          exitCode: undefined,
          signal: undefined,
        },
        4243,
      ),
    )
    const err = await run()
    expect(err).toBeInstanceOf(SandboxToolError)
    expect(err).not.toBeInstanceOf(SandboxSpawnError)
  })

  it("keeps a non-zero child exit as SandboxToolError (rejected, not retried)", async () => {
    execaMock.mockResolvedValue({
      stdout: "",
      stderr: "bad input",
      failed: true,
      timedOut: false,
      exitCode: 1,
    })
    const err = await run()
    expect(err).toBeInstanceOf(SandboxToolError)
    expect(err).not.toBeInstanceOf(SandboxSpawnError)
  })

  it("keeps a TIMEOUT as SandboxToolError (rejected, not retried)", async () => {
    execaMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      failed: true,
      timedOut: true,
      exitCode: undefined,
    })
    const err = await run()
    expect(err).toBeInstanceOf(SandboxToolError)
    expect((err as SandboxToolError).timedOut).toBe(true)
  })
})

describe("the image-lane entry is resolved from the running dist, not from a bundle-relative path", () => {
  it("honours MEDIA_IMAGE_LANE_ENTRY", () => {
    expect(
      loadImageLaneEntry({ MEDIA_IMAGE_LANE_ENTRY: "/opt/x/image-lane.js" } as NodeJS.ProcessEnv),
    ).toBe("/opt/x/image-lane.js")
  })

  it("defaults to image-lane.js beside the running entry file", () => {
    expect(loadImageLaneEntry({} as NodeJS.ProcessEnv)).toMatch(/image-lane\.js$/)
  })
})

describe("H8: the production binaries come from the image, never from npm", () => {
  it("refuses to resolve ffmpeg/ffprobe in production without the env paths", async () => {
    await expect(
      resolveMediaToolPaths({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/FFMPEG_PATH|FFPROBE_PATH/)
  })

  it("refuses a configured path that is not executable", async () => {
    await expect(
      resolveMediaToolPaths({
        NODE_ENV: "production",
        FFMPEG_PATH: "/nonexistent/ffmpeg",
        FFPROBE_PATH: "/nonexistent/ffprobe",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/not an executable file/)
  })

  it("uses the configured executables when they exist", async () => {
    const paths = await resolveMediaToolPaths({
      NODE_ENV: "production",
      FFMPEG_PATH: "/bin/sh",
      FFPROBE_PATH: "/bin/sh",
    } as NodeJS.ProcessEnv)
    expect(paths).toEqual({ ffmpeg: "/bin/sh", ffprobe: "/bin/sh" })
  })

  it("falls back to the vendored npm binaries outside production", async () => {
    const paths = await resolveMediaToolPaths({ NODE_ENV: "test" } as NodeJS.ProcessEnv)
    expect(paths.ffprobe).toMatch(/ffprobe/)
    expect(paths.ffmpeg).toMatch(/ffmpeg/)
  })
})
