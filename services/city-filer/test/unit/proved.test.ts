import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MS_PER_MINUTE } from "@civfix/api/time"
import { startFixturePortal, type FixturePortal } from "../fixtures/portal.js"
import { errorResult, fixtureScript, writes } from "../helpers/claude-acts.js"
import { filerHarness, type FilerHarness } from "../helpers/filer-harness.js"
import { exists } from "../helpers/files.js"

let h: FilerHarness
let portal: FixturePortal | undefined

afterEach(async () => {
  vi.useRealTimers()
  await portal?.close()
  portal = undefined
  await h?.close()
})

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

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
  it("T30: an existing script with no proved record goes to claude, then the proof, then one live run; the record then holds its sha256", async () => {
    const { portal, f } = await withPortal()
    const script = await h.installFixtureScript()
    await h.claude("")

    await h.run(f.id, 1)
    expect(h.steps()).toEqual(["claude", "dry-run", "live"])
    expect(portal.submissions).toHaveLength(1)
    expect(await h.proved()).toBe(sha256(script))
  })

  it("T31: an existing script whose sha256 equals the record runs live once, with no claude and no proof", async () => {
    const { portal, f } = await withPortal()
    await h.prove(await h.installFixtureScript())
    await h.claude("")

    await h.run(f.id, 1)
    expect(h.steps()).toEqual(["live"])
    expect(await h.claudeCalls()).toEqual([])
    expect(h.endings()).toEqual(["submitted/"])
    expect(portal.submissions).toHaveLength(1)
  })

  it("T32: a record holding another sha256 means claude and the proof before the one live run", async () => {
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
    await h.prove(
      await h.installScript(`import { writeFileSync } from "node:fs"
export default async () => {
  writeFileSync(process.env.FILER_RUN_DIR + "/out/result.json", JSON.stringify({ outcome: "needs_human", reason: "captcha" }))
  throw new Error("the form moved")
}
`),
    )
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
