
import { describe, expect, it } from "vitest"
import { parseProcStatus, sandboxProofFailure } from "../../src/sandbox/preflight.js"
import { assertSandboxPreflight } from "../../src/sandbox/preflight.js"

const IDENTITY = { uid: 1001, gid: 1001 }
const WORKER = { parentUid: 4242, parentGid: 4242 }

function status(over: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    Name: "cat",
    Uid: "1001\t1001\t1001\t1001",
    Gid: "1001\t1001\t1001\t1001",
    CapInh: "0000000000000000",
    CapPrm: "0000000000000000",
    CapEff: "0000000000000000",
    CapBnd: "00000000000000c0",
    CapAmb: "0000000000000000",
    NoNewPrivs: "1",
    ...over,
  }
  return Object.entries(fields)
    .map(([k, v]) => `${k}:\t${v}`)
    .join("\n")
}

describe("parseProcStatus", () => {
  it("reads the four uid/gid columns and every capability set", () => {
    const proof = parseProcStatus(status())
    expect(proof.uid).toEqual([1001, 1001, 1001, 1001])
    expect(proof.gid).toEqual([1001, 1001, 1001, 1001])
    expect(proof.caps.CapAmb).toBe(0n)
    expect(proof.caps.CapBnd).toBe(0xc0n)
  })
})

describe("sandboxProofFailure", () => {
  it("passes a child with the sandbox ids and no capabilities", () => {
    expect(sandboxProofFailure(status(), IDENTITY, WORKER)).toBeNull()
  })

  it("rejects a child still running as the worker's own uid, even when it matches the configured identity", () => {
    const failure = sandboxProofFailure(
      status({ Uid: "1000\t1000\t1000\t1000" }),
      { uid: 1000, gid: 1001 },
      { parentUid: 1000, parentGid: 4242 },
    )
    expect(failure).toMatch(/worker's own uid 1000/)
  })

  it("rejects a child still in the worker's own gid", () => {
    const failure = sandboxProofFailure(status(), IDENTITY, { parentUid: 4242, parentGid: 1001 })
    expect(failure).toMatch(/worker's own gid 1001/)
  })

  it("FAILS the ambient-capability leak this finding is about", () => {
    const leaked = status({ CapAmb: "00000000000000c0", CapPrm: "00000000000000c0", CapEff: "00000000000000c0" })
    expect(sandboxProofFailure(leaked, IDENTITY, WORKER)).toMatch(/CapInh|CapPrm|CapEff|CapAmb/)
  })

  it("fails any non-zero effective, permitted or inheritable set", () => {
    for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
      expect(sandboxProofFailure(status({ [name]: "0000000000000040" }), IDENTITY, WORKER)).toContain(
        name,
      )
    }
  })

  it("fails a child that is not fully the sandbox uid/gid (incl. a saved-set escape hatch)", () => {
    expect(sandboxProofFailure(status({ Uid: "1001\t1001\t1000\t1001" }), IDENTITY, WORKER)).toMatch(
      /Uid/,
    )
    expect(sandboxProofFailure(status({ Gid: "1001\t1001\t1001\t1000" }), IDENTITY, WORKER)).toMatch(
      /Gid/,
    )
    expect(sandboxProofFailure(status({ Uid: "1000\t1000\t1000\t1000" }), IDENTITY, WORKER)).toMatch(
      /Uid/,
    )
  })

  it("tolerates the container's own CAP_SETUID/CAP_SETGID bounding set, rejects anything wider", () => {
    expect(sandboxProofFailure(status({ CapBnd: "00000000000000c0" }), IDENTITY, WORKER)).toBeNull()
    expect(sandboxProofFailure(status({ CapBnd: "0000003fffffffff" }), IDENTITY, WORKER)).toMatch(
      /CapBnd/,
    )
  })

  it("requires a zero bounding set when the deployment drops it", () => {
    expect(
      sandboxProofFailure(status({ CapBnd: "00000000000000c0" }), IDENTITY, {
        ...WORKER,
        boundingMustBeZero: true,
      }),
    ).toMatch(/CapBnd/)
    expect(
      sandboxProofFailure(status({ CapBnd: "0000000000000000" }), IDENTITY, {
        ...WORKER,
        boundingMustBeZero: true,
      }),
    ).toBeNull()
  })

  it("judges the child against the worker ids it is given, not the host process's", () => {
    const hostUid = process.getuid?.() ?? 0
    const hostGid = process.getgid?.() ?? 0
    const child = status({
      Uid: `${hostUid}\t${hostUid}\t${hostUid}\t${hostUid}`,
      Gid: `${hostGid}\t${hostGid}\t${hostGid}\t${hostGid}`,
    })
    const failure = sandboxProofFailure(
      child,
      { uid: hostUid, gid: hostGid },
      { parentUid: hostUid + 1, parentGid: hostGid + 1 },
    )
    expect(failure).toBeNull()
  })

  it("fails when a capability line is missing entirely", () => {
    const text = status()
      .split("\n")
      .filter((l) => !l.startsWith("CapAmb:"))
      .join("\n")
    expect(sandboxProofFailure(text, IDENTITY, WORKER)).toMatch(/CapAmb/)
  })
})

describe("assertSandboxPreflight", () => {
  it("is a no-op outside production", async () => {
    await expect(
      assertSandboxPreflight({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).resolves.toBeUndefined()
  })

  it("refuses production without the sandbox identity", async () => {
    await expect(
      assertSandboxPreflight({
        NODE_ENV: "production",
        FFMPEG_PATH: "/bin/sh",
        FFPROBE_PATH: "/bin/sh",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow()
  })
})
