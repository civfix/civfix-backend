import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { collectEvidence, runEnding } from "../../src/output.js"
import { MB, pngOfSize } from "../helpers/files.js"

let dir: string
let out: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "filer-output-"))
  out = join(dir, "run", "out")
  await mkdir(out, { recursive: true })
  await writeFile(join(dir, "run", "packet.json"), "{}")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("the run's output", () => {
  it("T16: unparseable, unknown-outcome and oversized result.json are failed / portal_error; a caseUrl off the portal host is dropped", async () => {
    const run = { exitCode: 0, timedOut: false, sentinel: false, marker: false }
    const endings = []
    for (const content of [
      "not json {",
      JSON.stringify({ outcome: "done", evidence: [] }),
      JSON.stringify({ outcome: "submitted", caseId: "SR-1", evidence: [] }) +
        " ".repeat(70 * 1024),
      JSON.stringify({
        outcome: "submitted",
        caseId: "SR-1",
        caseUrl: "https://other.service-now.com/x",
        evidence: [],
      }),
    ]) {
      await writeFile(join(out, "result.json"), content)
      endings.push(
        await runEnding({
          outDir: out,
          host: "x.service-now.com",
          dryRun: false,
          run,
          log: () => {},
        }),
      )
    }

    const failed = { outcome: "failed", reason: "portal_error", evidenceNames: [] }
    expect(endings).toEqual([
      failed,
      failed,
      failed,
      { outcome: "submitted", caseId: "SR-1", evidenceNames: [] },
    ])
  })

  it("T17: of a symlink, a traversal, a nested path, a FIFO, a 6 MB PNG, a .txt and a valid PNG, only the valid PNG is kept", async () => {
    await symlink("/proc/self/environ", join(out, "environ.png"))
    await mkdir(join(out, "sub"))
    await writeFile(join(out, "sub", "a.png"), pngOfSize(1000))
    execFileSync("mkfifo", [join(out, "a.png")])
    await writeFile(join(out, "big.png"), pngOfSize(6 * MB))
    await writeFile(join(out, "notes.txt"), "hello")
    const valid = pngOfSize(100 * 1024)
    await writeFile(join(out, "valid.png"), valid)

    const names = [
      "environ.png",
      "../../packet.json",
      "sub/a.png",
      "a.png",
      "big.png",
      "notes.txt",
      "valid.png",
    ]
    const kept = await collectEvidence(out, names, () => {})
    expect(kept.map(({ name, ext, bytes }) => ({ name, ext, bytes }))).toEqual([
      { name: "valid.png", ext: "png", bytes: valid },
    ])
  })

  it("T18: of 25 valid PNGs the first 20 are kept", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `shot-${String(i).padStart(2, "0")}.png`)
    for (const name of names) await writeFile(join(out, name), pngOfSize(2000))

    expect((await collectEvidence(out, names, () => {})).map((e) => e.name)).toEqual(
      names.slice(0, 20),
    )
  })
})

describe("a broken linked_existing result", () => {
  it("is uncertain_submission past the submit marker and portal_error before it", async () => {
    const endings = []
    for (const marker of [true, false]) {
      for (const result of [
        { outcome: "linked_existing", caseId: "<bad>", evidence: [] },
        { outcome: "linked_existing", evidence: [] },
      ]) {
        await writeFile(join(out, "result.json"), JSON.stringify(result))
        const ending = await runEnding({
          outDir: out,
          host: "portal.test",
          dryRun: false,
          run: { exitCode: 0, timedOut: false, sentinel: false, marker },
          log: () => {},
        })
        endings.push(`${ending.outcome}/${"reason" in ending ? ending.reason : ""}`)
      }
    }

    expect(endings).toEqual([
      "failed/uncertain_submission",
      "failed/uncertain_submission",
      "failed/portal_error",
      "failed/portal_error",
    ])
  })
})
