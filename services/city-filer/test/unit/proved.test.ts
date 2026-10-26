import { execFileSync } from "node:child_process"
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MS_PER_MINUTE } from "@civfix/api/time"
import { fingerprintPortal, forgetProved } from "../../src/proved.js"
import { startFixturePortal, type FixturePortal } from "../fixtures/portal.js"
import {
  errorResult,
  fixtureScript,
  PROVABLE_SCRIPT,
  resultFile,
  writes,
} from "../helpers/claude-acts.js"
import { PORTAL_HOST } from "../helpers/fake-filings-worker.js"
import { filerHarness, testGit, type FilerHarness } from "../helpers/filer-harness.js"
import { exists } from "../helpers/files.js"

/** Runs once each time the wrapper has written a proved record, before it goes on. */
const afterRecord = vi.hoisted(() => ({ fn: null as (() => Promise<void>) | null }))

vi.mock("../../src/proved.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/proved.js")>()
  return {
    ...actual,
    recordProved: async (...args: Parameters<typeof actual.recordProved>) => {
      await actual.recordProved(...args)
      await afterRecord.fn?.()
    },
  }
})

let h: FilerHarness
let portal: FixturePortal | undefined

afterEach(async () => {
  afterRecord.fn = null
  vi.useRealTimers()
  await portal?.close()
  portal = undefined
  await h?.close()
})

/** The fingerprint of portals/<host>/ as it is now; the test fails when it has none. */
async function fingerprint(host = PORTAL_HOST): Promise<string> {
  const folder = await fingerprintPortal(h.workspace, host)
  if (folder.kind !== "ok") throw new Error(`portals/${host}/ was rejected: ${folder.why}`)
  return folder.fingerprint
}

const read = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8")

async function withPortal() {
  h = await filerHarness()
  portal = await startFixturePortal()
  return { portal, f: h.filings.add({ packet: { formUrl: portal.formUrl } }) }
}

/** The fixture script, made to throw in a dry run: its proof always fails. */
const unprovable = async () =>
  (await fixtureScript()).replace(
    "export default async function file(packet) {",
    `export default async function file(packet) {
  if (process.argv.includes("--dry-run")) throw new Error("not ready")`,
  )

describe("only proved scripts run live", () => {
  it("T30: an existing script with no proved record goes to claude, then the proof, then one live run; the record then holds the fingerprint of portals/<host>/", async () => {
    const { portal, f } = await withPortal()
    await h.installFixtureScript()
    await h.claude("")

    await h.run(f.id, 1)
    expect(h.steps()).toEqual(["claude", "dry-run", "live"])
    expect(portal.submissions).toHaveLength(1)
    expect(await h.proved()).toBe(await fingerprint())
  })

  it("T31: an existing script whose folder's fingerprint equals the record runs live once, with no claude and no proof", async () => {
    const { portal, f } = await withPortal()
    await h.installFixtureScript()
    await h.prove()
    await h.claude("")

    await h.run(f.id, 1)
    expect(h.steps()).toEqual(["live"])
    expect(await h.claudeCalls()).toEqual([])
    expect(h.endings()).toEqual(["submitted/"])
    expect(portal.submissions).toHaveLength(1)
  })

  it("T32: a record holding a value other than the folder's fingerprint means claude and the proof before the one live run", async () => {
    const { f } = await withPortal()
    await h.installFixtureScript()
    await h.prove("an older script")
    await h.claude("")

    await h.run(f.id, 1)
    expect(h.steps()).toEqual(["claude", "dry-run", "live"])
  })

  it("T33: after a failed proof, a usage limit or a timeout, attempt 1 leaves no record and no submit, and attempt 2 starts with claude and the proof", async () => {
    const outcomes = []
    for (const ending of ["proof fails", "usage limit", "timeout"] as const) {
      const { portal, f } = await withPortal()
      const script = ending === "proof fails" ? await unprovable() : await fixtureScript()
      const after = {
        "proof fails": "",
        "usage limit": errorResult("usage limit reached"),
        timeout: "setInterval(() => {}, 1000)\nawait new Promise(() => {})",
      }[ending]
      await h.claude(`if (n > 0) return\n${writes(script)}\n${after}`)

      if (ending === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const run = h.run(f.id, 1)
        await vi.waitFor(async () => expect(await h.claudeCalls()).toHaveLength(1), {
          timeout: 20_000,
          interval: 50,
        })
        vi.advanceTimersByTime(15 * MS_PER_MINUTE)
        await run
        vi.useRealTimers()
      } else {
        await h.run(f.id, 1)
      }
      const first = { record: await h.proved(), submits: portal.submissions.length }
      const steps = h.steps().length
      Object.assign(f, { status: "queued" })
      await h.run(f.id, 2)
      outcomes.push({ ending, ...first, attempt2: h.steps().slice(steps, steps + 2) })
      await portal.close()
      await h.close()
    }

    expect(outcomes).toEqual([
      { ending: "proof fails", record: null, submits: 0, attempt2: ["claude", "dry-run"] },
      { ending: "usage limit", record: null, submits: 0, attempt2: ["claude", "dry-run"] },
      { ending: "timeout", record: null, submits: 0, attempt2: ["claude", "dry-run"] },
    ])
  })

  it("T34: a host with a record whose rewritten script fails its proof loses the record; failed / portal_error, no live run", async () => {
    const { f } = await withPortal()
    await h.prove("an older script")
    await h.claude(writes(await unprovable()))

    await h.run(f.id, 1)
    expect(await h.proved()).toBeNull()
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.steps()).toEqual(["claude", "dry-run"])
  })

  it("T35: the image makes /workspace/proved node:node 0755 and ignores it in git; a passing proof's spawns name no proved/ path", async () => {
    const dockerfile = await read("../../Dockerfile")
    const runtime = dockerfile.slice(dockerfile.indexOf("FROM base AS runtime"))
    expect(runtime).toMatch(
      /^ && install -d -o node -g node -m 0755 (\S+ )*\/workspace\/proved( |$)/m,
    )
    expect(runtime).toMatch(/printf '([^']*\\n)?proved\/\\n[^']*' > \/workspace\/.gitignore/)

    const { f } = await withPortal()
    await h.claude(writes(await fixtureScript()))
    await h.run(f.id, 1)
    expect(await h.proved()).not.toBeNull()
    const proved = join(h.workspace, "proved")
    expect(h.spawns.flatMap((s) => s.args).filter((a) => a.includes(proved))).toEqual([])
  })

  it("T42: a proved script's own needs_human / captcha before a non-zero exit is not claude's: it goes to the proof and ends failed / portal_error", async () => {
    h = await filerHarness()
    await h.installScript(`import { writeFileSync } from "node:fs"
export default async () => {
  writeFileSync(process.env.FILER_RUN_DIR + "/out/result.json", JSON.stringify({ outcome: "needs_human", reason: "captcha" }))
  throw new Error("the form moved")
}
`)
    await h.prove()
    await h.claude("")
    const f = h.filings.add()

    await h.run(f.id, 1)
    const runDir = h.runDir(f.id, f.runId)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.steps()).toEqual(["live", "claude", "dry-run"])
    expect(await exists(join(runDir, "out-live", "result.json"))).toBe(true)
    expect(await exists(join(runDir, "out-claude", "result.json"))).toBe(false)
  })
})

/** A script that leaves its live run to ./lib.mjs. */
const IMPORTS_LIB = `import { result } from "@civfix/filer-kit"
import { finish } from "./lib.mjs"
export default async () => finish(result)
`

/** Passes the proof, and fails live before the submit. */
const LIB_FAILS = `export const finish = (result) => {
  if (process.argv.includes("--dry-run")) return result({ outcome: "linked_existing", caseId: "SR-0007" })
  throw new Error("the form moved")
}
`

/** Passes the proof, and submits live. */
const LIB_SUBMITS = `export const finish = (result) =>
  result({ outcome: process.argv.includes("--dry-run") ? "linked_existing" : "submitted", caseId: "SR-0007" })
`

const hostDir = (host = PORTAL_HOST) => join(h.workspace, "portals", host)

/** script.mjs importing lib.mjs (LIB_FAILS by default), with a matching proved record. */
async function provedWithLib(lib = LIB_FAILS): Promise<void> {
  await h.installScript(IMPORTS_LIB)
  await writeFile(join(hostDir(), "lib.mjs"), lib)
  await h.prove()
}

/** Act lines: write `source` as this run's host's lib.mjs. */
const writesLib = (source: string) =>
  `fs.writeFileSync(join(workspace, "portals", host, "lib.mjs"), ${JSON.stringify(source)})`

describe("the proved fingerprint covers the portal's whole folder", () => {
  it("T43: after claude edits only lib.mjs and hits its usage limit, attempt 2 goes through claude and the proof before any live run", async () => {
    h = await filerHarness()
    await provedWithLib()
    await h.claude(`if (n > 0) return
      ${writesLib(LIB_SUBMITS)}
      ${errorResult("usage limit reached")}`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    const attempt1 = h.steps()
    Object.assign(f, { status: "queued" })
    await h.run(f.id, 2)

    expect(h.endings()[0]).toBe("failed/ai_unavailable")
    expect(attempt1).toEqual(["live", "claude"])
    expect(h.steps().slice(attempt1.length)).toEqual(["claude", "dry-run", "live"])
    expect(h.endings()[1]).toBe("submitted/")
  })

  it("T44: after claude's own needs_human / captcha with script.mjs as it was and lib.mjs edited, attempt 2 goes through claude and the proof before any live run", async () => {
    h = await filerHarness()
    await provedWithLib()
    const script = await readFile(join(hostDir(), "script.mjs"))
    await h.claude(`if (n > 0) return
      ${writesLib(LIB_SUBMITS)}
      ${resultFile({ outcome: "needs_human", reason: "captcha" })}`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    const attempt1 = h.steps()
    const scriptAfter = await readFile(join(hostDir(), "script.mjs"))
    Object.assign(f, { status: "queued" })
    await h.run(f.id, 2)

    expect(scriptAfter.equals(script)).toBe(true)
    expect(h.endings()[0]).toBe("needs_human/captcha")
    expect(attempt1).toEqual(["live", "claude"])
    expect(h.steps().slice(attempt1.length)).toEqual(["claude", "dry-run", "live"])
  })

  it("T45: with a matching record and lib.mjs changed in the workspace, as a revert would, claude and the proof run before the one live run; the record then holds the new folder's fingerprint", async () => {
    h = await filerHarness()
    await provedWithLib()
    const before = await h.proved()
    testGit(h.workspace, "add", "-A")
    testGit(h.workspace, "commit", "--quiet", "-m", "portal")
    await writeFile(join(hostDir(), "lib.mjs"), LIB_SUBMITS)
    testGit(h.workspace, "commit", "--quiet", "-am", "Revert the lib")
    await h.claude("")

    await h.run(h.filings.add().id, 1)
    expect(h.steps()).toEqual(["claude", "dry-run", "live"])
    expect(h.endings()).toEqual(["submitted/"])
    expect(await h.proved()).toBe(await fingerprint())
    expect(await h.proved()).not.toBe(before)
  })

  it("T46: lib.mjs changing after the proof passed, before the live run, is failed / portal_error with no live run and no submit", async () => {
    const { portal, f } = await withPortal()
    await h.installFixtureScript()
    await writeFile(join(hostDir(), "lib.mjs"), "export const unused = 1\n")
    await h.claude("")
    afterRecord.fn = () => writeFile(join(hostDir(), "lib.mjs"), "export const unused = 2\n")

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.steps()).toEqual(["claude", "dry-run"])
    expect(portal.submissions).toHaveLength(0)
  })

  it("a script that changes its own folder during its proof loses the host's record; failed / portal_error, no live run", async () => {
    h = await filerHarness()
    await h.installScript(`import { writeFileSync } from "node:fs"
import { result } from "@civfix/filer-kit"
export default async () => {
  writeFileSync(new URL("./lib.mjs", import.meta.url), "export const changed = true\\n")
  await result({ outcome: "linked_existing", caseId: "SR-0007" })
}
`)
    await h.prove("an older script")
    await h.claude("")

    await h.run(h.filings.add().id, 1)
    expect(await h.proved()).toBeNull()
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.steps()).toEqual(["claude", "dry-run"])
  })

  it("T47: a symlink, 501 entries or a FIFO in portals/<host>/ rejects the folder; the attempt goes to claude, never runs live, ends failed / portal_error and deletes the record", async () => {
    const outcomes = []
    for (const added of ["symlink", "501 entries", "fifo"] as const) {
      h = await filerHarness()
      await h.installScript(PROVABLE_SCRIPT)
      await h.prove()
      await h.claude("")
      if (added === "symlink") await symlink("script.mjs", join(hostDir(), "alias.mjs"))
      if (added === "501 entries") {
        for (let i = 0; i < 500; i += 1) await writeFile(join(hostDir(), `f${i}.txt`), "")
      }
      if (added === "fifo") execFileSync("mkfifo", [join(hostDir(), "pipe")])

      const folder = await fingerprintPortal(h.workspace, PORTAL_HOST)
      await h.run(h.filings.add().id, 1)
      outcomes.push({
        added,
        folder: folder.kind,
        steps: h.steps(),
        endings: h.endings(),
        record: await h.proved(),
      })
      await h.close()
    }

    const rejected = { folder: "rejected", steps: ["claude"], endings: ["failed/portal_error"] }
    expect(outcomes).toEqual([
      { added: "symlink", ...rejected, record: null },
      { added: "501 entries", ...rejected, record: null },
      { added: "fifo", ...rejected, record: null },
    ])
  })

  it("T48: moving bytes between a file's name and its content, or adding an empty subdirectory, changes the fingerprint", async () => {
    h = await filerHarness()
    const folder = async (host: string, files: Record<string, string>) => {
      await mkdir(hostDir(host))
      for (const [name, text] of Object.entries(files))
        await writeFile(join(hostDir(host), name), text)
      return fingerprint(host)
    }

    const a = await folder("a.example", { a: "bc" })
    const ab = await folder("ab.example", { ab: "c" })
    const before = await folder("c.example", { "script.mjs": PROVABLE_SCRIPT })
    await mkdir(join(hostDir("c.example"), "empty"))
    const after = await fingerprint("c.example")

    expect(a).not.toBe(ab)
    expect(before).not.toBe(after)
  })

  it("is the same for the same tree under another host, and rejects past 500 entries or 20 MiB, a name that isn't UTF-8 and a directory node can't list, without throwing", async () => {
    h = await filerHarness()
    const reject = async (host: string) => {
      const folder = await fingerprintPortal(h.workspace, host)
      return folder.kind === "rejected" ? "rejected" : "ok"
    }
    await mkdir(join(hostDir("one.example"), "sub"), { recursive: true })
    await mkdir(join(hostDir("two.example"), "sub"), { recursive: true })
    for (const host of ["one.example", "two.example"]) {
      await writeFile(join(hostDir(host), "sub", "lib.mjs"), "export default 1\n")
    }

    await mkdir(hostDir("entries.example"))
    for (let i = 0; i < 499; i += 1) {
      await writeFile(join(hostDir("entries.example"), `f${i}`), "")
    }
    const entries500 = await reject("entries.example")
    await writeFile(join(hostDir("entries.example"), "f499"), "")
    const entries501 = await reject("entries.example")

    await mkdir(hostDir("bytes.example"))
    await writeFile(join(hostDir("bytes.example"), "a"), Buffer.alloc(10 * 1024 * 1024))
    await writeFile(join(hostDir("bytes.example"), "b"), Buffer.alloc(10 * 1024 * 1024))
    const bytes20MiB = await reject("bytes.example")
    await writeFile(join(hostDir("bytes.example"), "c"), "x")
    const bytesOver = await reject("bytes.example")

    await mkdir(hostDir("name.example"))
    await writeFile(Buffer.from(`${hostDir("name.example")}/\xff`, "latin1"), "")

    await mkdir(join(hostDir("closed.example"), "sub"), { recursive: true })
    await chmod(join(hostDir("closed.example"), "sub"), 0o300)
    const closed = await reject("closed.example")
    await chmod(join(hostDir("closed.example"), "sub"), 0o700)

    expect(await fingerprint("one.example")).toBe(await fingerprint("two.example"))
    expect({ entries500, entries501, bytes20MiB, bytesOver }).toEqual({
      entries500: "ok",
      entries501: "rejected",
      bytes20MiB: "ok",
      bytesOver: "rejected",
    })
    expect(await reject("name.example")).toBe("rejected")
    expect(closed).toBe("rejected")
    expect(await reject("missing.example")).toBe("rejected")
  })
})

describe("forgetting proved records", () => {
  it("never takes an empty or unsafe name for a host, and one that fails doesn't stop the rest", async () => {
    h = await filerHarness()
    await h.prove("a", "a.example")
    await h.prove("b", "b.example")

    await expect(
      forgetProved(h.workspace, ["", "a.example", "../proved", "b.example"], h.log, "test"),
    ).rejects.toBeInstanceOf(AggregateError)
    expect(await readdir(join(h.workspace, "proved"))).toEqual([])
    expect(await readdir(h.workspace)).toContain("proved")
  })
})
