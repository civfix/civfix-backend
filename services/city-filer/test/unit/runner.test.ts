import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runScript } from "../../src/script.js"
import { PORTAL_HOST } from "../helpers/fake-filings-worker.js"
import { filerHarness, type FilerHarness } from "../helpers/filer-harness.js"

let h: FilerHarness

afterEach(async () => {
  await h?.close()
})

const OWN_SHA256 = `import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
const own = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex")
`

const BACKGROUND_SLEEP = `import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
function startSleep() {
  const child = spawn("sleep", ["600"], { stdio: "ignore" })
  child.unref()
  writeFileSync(process.env.FILER_RUN_DIR + "/out/sleep.pid", String(child.pid))
}
`

/** Gone, or a zombie nobody has reaped yet: either way it no longer runs. */
async function processGone(runDir: string): Promise<boolean> {
  const pid = Number(await readFile(join(runDir, "out", "sleep.pid"), "utf8"))
  for (let i = 0; i < 30; i++) {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null)
    if (stat === null || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

describe("the script runner", () => {
  it("T13: a sentinel with another sha256, or one written to a file, is no sentinel", async () => {
    h = await filerHarness()
    const runs = []
    for (const body of [
      `export default async () => console.log("CIVFIX_FILER_DRY_RUN_OK " + (own[0] === "0" ? "1" : "0") + own.slice(1))`,
      `export default async () => writeFileSync(process.env.FILER_RUN_DIR + "/out/s.txt", "CIVFIX_FILER_DRY_RUN_OK " + own + "\\n")`,
    ]) {
      const scriptSha256 = createHash("sha256")
        .update(await h.installScript(OWN_SHA256 + body))
        .digest("hex")
      const runDir = join(h.workspace, "runs", `t13-${runs.length}`)
      await mkdir(join(runDir, "out"), { recursive: true })
      await writeFile(join(runDir, "packet.json"), "{}")
      runs.push(
        await runScript(h.runner, {
          runDir,
          host: PORTAL_HOST,
          dryRun: true,
          scriptSha256,
          timeoutMs: 30_000,
        }),
      )
    }

    expect(runs).toMatchObject([
      { exitCode: 0, sentinel: false },
      { exitCode: 0, sentinel: false },
    ])
  })

  it("T21: filer-shell is spawned with an empty env, and the script sees exactly filer-shell's six variables", async () => {
    h = await filerHarness()
    const saved = process.env
    process.env = {
      ...saved,
      DATABASE_URL: "postgres://filer:secret@db/civfix",
      R2_ACCESS_KEY_ID: "key-id",
      R2_SECRET_ACCESS_KEY: "secret",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
    }
    await h.installScript(`import { execFileSync } from "node:child_process"
      import { writeFileSync } from "node:fs"
      export default async () => writeFileSync(process.env.FILER_RUN_DIR + "/out/env.txt", execFileSync("/usr/bin/env"))`)
    const f = h.filings.add()
    try {
      await h.run(f.id, 1)
    } finally {
      process.env = saved
    }

    expect(h.spawnEnvs).toEqual([{}])
    const env = await readFile(join(h.runDir(f.id, f.runId), "out", "env.txt"), "utf8")
    expect(
      env
        .trim()
        .split("\n")
        .map((l) => l.split("=")[0])
        .sort(),
    ).toEqual(["FILER_HOST", "FILER_RUN_DIR", "HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR"])
  })

  it("T22: a background sleep 600 left by a script that exits is killed with its process group", async () => {
    h = await filerHarness()
    await h.installScript(`${BACKGROUND_SLEEP}export default async () => startSleep()`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    expect(await processGone(h.runDir(f.id, f.runId))).toBe(true)
  })

  it("T32: a script past the run timeout is killed with its background child and ends failed / portal_error", async () => {
    h = await filerHarness({ scriptTimeoutMs: 3000 })
    await h.installScript(`${BACKGROUND_SLEEP}export default async () => {
      startSleep()
      setInterval(() => {}, 1000)
      await new Promise(() => {})
    }`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(await processGone(h.runDir(f.id, f.runId))).toBe(true)
  })
})
