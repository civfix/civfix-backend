import { createHash } from "node:crypto"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runScript } from "../../src/script.js"
import { startFixturePortal, type FixturePortal } from "../fixtures/portal.js"
import { fixtureScript, PROVABLE_SCRIPT, writes } from "../helpers/claude-acts.js"
import { PORTAL_HOST } from "../helpers/fake-filings-worker.js"
import { filerHarness, testGit, type FilerHarness } from "../helpers/filer-harness.js"

let h: FilerHarness
let portal: FixturePortal | undefined

afterEach(async () => {
  await portal?.close()
  portal = undefined
  await h?.close()
})

const logged = (line: string) => h.logs.filter((l) => l.line === line).map((l) => l.fields)

/** A dry run of `source` as the host's script, in a run directory of its own; a function gets that directory. */
async function dryRun(name: string, source: string | ((runDir: string) => Promise<string>)) {
  const runDir = join(h.workspace, "runs", name)
  await mkdir(join(runDir, "out"), { recursive: true })
  await writeFile(join(runDir, "packet.json"), "{}")
  const script = await h.installScript(typeof source === "string" ? source : await source(runDir))
  return runScript(h.runner, {
    runDir,
    host: PORTAL_HOST,
    dryRun: true,
    scriptSha256: createHash("sha256").update(script).digest("hex"),
    timeoutMs: 30_000,
  })
}

const LINKED = `await result({ outcome: "linked_existing", caseId })`

describe("a portal script loads code only from its own folder and the image", () => {
  it("T49: a script from claude importing ../other.example/lib.mjs fails its proof, which names the refused path; no record, failed / portal_error, no live run, no submit", async () => {
    h = await filerHarness()
    portal = await startFixturePortal()
    const f = h.filings.add({ packet: { formUrl: portal.formUrl } })
    const lib = join(h.workspace, "portals", "other.example", "lib.mjs")
    await mkdir(dirname(lib), { recursive: true })
    await writeFile(lib, "export const ready = () => true\n")
    testGit(h.workspace, "add", "-A")
    testGit(h.workspace, "commit", "--quiet", "-m", "other.example")
    const script = `import { ready } from "../other.example/lib.mjs"\n${(
      await fixtureScript()
    ).replace(
      "export default async function file(packet) {",
      `export default async function file(packet) {
  if (!ready()) throw new Error("not ready")`,
    )}`
    await h.claude(writes(script))

    await h.run(f.id, 1)
    const proof = h.spawns.findIndex(
      (s) => s.args.includes(h.runner.kitRunScript) && s.args.includes("--dry-run"),
    )
    const [proofRun] = logged("filer: proof finished")
    expect(proofRun?.exitCode).not.toBe(0)
    expect(proofRun?.sentinel).toBe(false)
    expect(await h.proved()).toBeNull()
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.steps()).toEqual(["claude", "dry-run"])
    expect(portal.submissions).toEqual([])
    expect(h.spawnStderrs[proof]).toContain(await realpath(lib))
  })

  it("T50: a script loading a module from TMPDIR by import(), from HOME through createRequire, or from its run's out/ by a static import fails its dry run without the sentinel", async () => {
    h = await filerHarness()
    const runs = [
      await dryRun(
        "t50-tmpdir",
        `import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { result } from "@civfix/filer-kit"
export default async () => {
  const path = join(tmpdir(), "civfix-t50-" + process.pid + ".mjs")
  writeFileSync(path, "export const caseId = 'SR-0007'\\n")
  try {
    const { caseId } = await import(pathToFileURL(path).href)
    ${LINKED}
  } finally {
    rmSync(path)
  }
}
`,
      ),
      await dryRun(
        "t50-home",
        `import { writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { result } from "@civfix/filer-kit"
export default async () => {
  const path = join(homedir(), "t50.cjs")
  writeFileSync(path, "exports.caseId = 'SR-0007'\\n")
  const { caseId } = createRequire(import.meta.url)(path)
  ${LINKED}
}
`,
      ),
      await dryRun("t50-out", async (runDir) => {
        const path = join(runDir, "out", "x.mjs")
        await writeFile(path, "export const caseId = 'SR-0007'\n")
        return `import { caseId } from ${JSON.stringify(path)}
import { result } from "@civfix/filer-kit"
export default async () => {
  ${LINKED}
}
`
      }),
    ]

    expect(runs.map((r) => ({ failed: r.exitCode !== 0, sentinel: r.sentinel }))).toEqual([
      { failed: true, sentinel: false },
      { failed: true, sentinel: false },
      { failed: true, sentinel: false },
    ])
  })

  it("T51: a script importing ./lib.mjs, @civfix/filer-kit, node:fs and playwright-core passes its dry run with the sentinel and its sha256", async () => {
    h = await filerHarness()
    await mkdir(join(h.workspace, "portals", PORTAL_HOST), { recursive: true })
    await writeFile(
      join(h.workspace, "portals", PORTAL_HOST, "lib.mjs"),
      "export const caseId = 'SR-0007'\n",
    )
    // No node_modules under the workspace holds playwright-core: a script reaches it where the kit does.
    const ran = await dryRun(
      "t51",
      `import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { result } from "@civfix/filer-kit"
import { caseId } from "./lib.mjs"
const { chromium } = createRequire(import.meta.resolve("@civfix/filer-kit"))("playwright-core")
export default async () => {
  if (typeof chromium.launchPersistentContext !== "function") throw new Error("no playwright-core")
  readFileSync(new URL("./lib.mjs", import.meta.url))
  ${LINKED}
}
`,
    )

    expect(ran).toMatchObject({ exitCode: 0, sentinel: true })
  })

  it("T52: an existing script with no matching record gives claude a prompt naming portals/<host>/ as changed since its last passing dry run", async () => {
    h = await filerHarness()
    await h.installScript(PROVABLE_SCRIPT)
    await h.prove("an older script")
    await h.claude("")

    await h.run(h.filings.add().id, 1)
    const calls = await h.claudeCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.stdin).toContain(
      `portals/${PORTAL_HOST}/ has changed since its last passing dry run`,
    )
  })
})
