import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, link, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeScratch, readScratchOutput, ScratchOutputError } from "../../src/sandbox/tmp.js"
import { resetSandboxIdentity } from "../../src/sandbox/exec.js"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "civfix-scratch-io-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  resetSandboxIdentity()
})

const SELF_UID = process.getuid?.() ?? null
const MAX_BYTES = 10 * 1024 * 1024

describe("readScratchOutput", () => {
  it("reads a regular file the sandbox uid owns", async () => {
    await writeFile(join(dir, "out.bin"), Buffer.from("bytes"))
    expect((await readScratchOutput(dir, "out.bin", SELF_UID, MAX_BYTES)).toString()).toBe("bytes")
  })

  it("refuses a SYMLINK at open time (O_NOFOLLOW), never following it", async () => {
    await symlink("/etc/hosts", join(dir, "out.bin"))

    const err = await readScratchOutput(dir, "out.bin", SELF_UID, MAX_BYTES).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ScratchOutputError)
    expect(String(err)).toMatch(/could not be opened safely/)
  })

  it("refuses a HARDLINK to a file outside the scratch dir", async () => {
    const outside = join(tmpdir(), `civfix-scratch-outside-${process.pid}`)
    await writeFile(outside, Buffer.from("secret"))
    try {
      await link(outside, join(dir, "out.bin"))

      await expect(readScratchOutput(dir, "out.bin", SELF_UID, MAX_BYTES)).rejects.toThrow(
        /hard-linked/,
      )
    } finally {
      await rm(outside, { force: true })
    }
  })

  it("refuses a FIFO instead of blocking on it (O_NONBLOCK)", async () => {
    execFileSync("/usr/bin/mkfifo", [join(dir, "out.bin")])

    const err = await readScratchOutput(dir, "out.bin", SELF_UID, MAX_BYTES).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ScratchOutputError)
    expect(String(err)).toMatch(/not a regular file|could not be opened safely/)
  })

  it("refuses a file owned by someone other than the sandbox uid", async () => {
    await writeFile(join(dir, "out.bin"), Buffer.from("bytes"))

    await expect(
      readScratchOutput(dir, "out.bin", (SELF_UID ?? 0) + 1234, MAX_BYTES),
    ).rejects.toThrow(/not owned by the sandbox uid/)
  })

  it("refuses an output larger than the lane cap, without reading it", async () => {
    await writeFile(join(dir, "out.bin"), Buffer.alloc(1024))

    await expect(readScratchOutput(dir, "out.bin", SELF_UID, 512)).rejects.toThrow(/byte cap/)
  })

  it("refuses a missing output", async () => {
    await expect(readScratchOutput(dir, "out.bin", SELF_UID, MAX_BYTES)).rejects.toThrow(
      /could not be opened safely/,
    )
  })
})

describe("scratch.seal", () => {
  it("closes the group-write window before the parent reads", async () => {
    const scratch = await makeScratch(new Uint8Array([1]), "bin")
    try {
      await scratch.seal()

      const mode = (await stat(scratch.dir)).mode & 0o777
      expect(mode).toBe(0o700)
    } finally {
      await scratch.cleanup()
    }
  })

  it("still lets the owner read its contents and clean up afterwards", async () => {
    const scratch = await makeScratch(new Uint8Array([1]), "bin")
    await writeFile(join(scratch.dir, "out.bin"), Buffer.from("ok"))
    await scratch.seal()

    expect((await readScratchOutput(scratch.dir, "out.bin", SELF_UID, MAX_BYTES)).toString()).toBe(
      "ok",
    )
    await scratch.cleanup()
  })
})
