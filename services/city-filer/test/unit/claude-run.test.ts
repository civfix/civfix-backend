import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MS_PER_MINUTE } from "@civfix/api/time"
import { FILER_ENV_KEYS } from "../../src/preflight.js"
import { startFixturePortal, type FixturePortal } from "../fixtures/portal.js"
import {
  FAILING_SCRIPT,
  fixtureScript,
  PROVABLE_SCRIPT,
  resultFile,
  writes,
} from "../helpers/claude-acts.js"
import { PORTAL_HOST } from "../helpers/fake-filings-worker.js"
import { filerHarness, type FilerHarness } from "../helpers/filer-harness.js"
import { exists, pngOfSize } from "../helpers/files.js"

let h: FilerHarness
let portal: FixturePortal | undefined

afterEach(async () => {
  vi.useRealTimers()
  await portal?.close()
  portal = undefined
  await h?.close()
})

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const logged = (line: string) => h.logs.filter((l) => l.line === line).map((l) => l.fields)

/** D7's filer-shell variables, the only ones a filer process may see. */
const FILER_KEYS: string[] = [...FILER_ENV_KEYS, "FILER_RUN_DIR", "FILER_HOST"]

/** Running: neither gone nor a zombie nobody has reaped yet. */
async function running(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null)
  return stat !== null && !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")
}

async function withPortal(dryRun = false) {
  h = await filerHarness({ dryRun })
  portal = await startFixturePortal()
  return { portal, f: h.filings.add({ packet: { formUrl: portal.formUrl } }) }
}

describe("a filing run with Claude Code", () => {
  it("T1: with no script, fake claude runs once through filer-shell with D9's flags only, the prompt on stdin and an empty spawn env", async () => {
    h = await filerHarness()
    await h.claude("")
    const f = h.filings.add()

    await h.run(f.id, 1)
    const runDir = h.runDir(f.id, f.runId)
    const calls = await h.claudeCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual([
      ...["-p", "--output-format", "json", "--model", "test-run-model"],
      ...["--append-system-prompt-file", "/app/playbook/filing.md"],
      ...["--tools", "Bash,Read,Write,Edit,Glob,Grep", "--dangerously-skip-permissions"],
      ...["--strict-mcp-config", "--mcp-config", join(runDir, "mcp.json")],
    ])
    const mcp = JSON.parse(await readFile(join(runDir, "mcp.json"), "utf8")) as unknown
    const args = ["--browser", "chromium", "--headless", "--no-sandbox", "--isolated"]
    expect(mcp).toEqual({ mcpServers: { playwright: { command: "playwright-mcp", args } } })
    expect(calls[0]?.stdin).toContain(join(runDir, "packet.json"))
    expect(calls[0]?.stdin).toContain(PORTAL_HOST)
    expect(calls[0]?.cwd).toBe(await realpath(runDir))
    const filerShellArgs = ["--run-dir", runDir, "--host", PORTAL_HOST, "--", "claude"]
    expect(h.spawns.filter((s) => s.args.includes("claude"))).toEqual([
      {
        command: h.runner.filerShell,
        args: [...filerShellArgs, ...(calls[0]?.argv ?? [])],
        env: {},
      },
    ])
  })

  it("T2: a working script from claude passes the wrapper's proof with its sha256, then runs live once and is submitted with one submit", async () => {
    const { portal, f } = await withPortal()
    const script = await fixtureScript()
    await h.claude(writes(script))

    await h.run(f.id, 1)
    expect(logged("filer: proof finished")).toMatchObject([{ exitCode: 0, sentinel: true }])
    expect(h.scriptRuns()).toEqual(["dry-run", "live"])
    expect(h.results()).toMatchObject([
      { outcome: "submitted", caseId: "SR-0001", scriptVersion: sha256(script).slice(0, 12) },
    ])
    expect(portal.submissions).toHaveLength(1)
  })

  it("T2b: a portal showing SR-0042 passes the proof at the dry-run linked_existing result and links live, with no submit", async () => {
    const { portal, f } = await withPortal()
    portal.mode = "similar"
    await h.claude(writes(await fixtureScript()))

    await h.run(f.id, 1)
    expect(logged("filer: proof finished")).toMatchObject([{ exitCode: 0, sentinel: true }])
    expect(h.scriptRuns()).toEqual(["dry-run", "live"])
    expect(h.results().map((r) => [r.outcome, r.caseId])).toEqual([["linked_existing", "SR-0042"]])
    expect(portal.submissions).toEqual([])
  })

  it("T3: a script that throws in its dry run fails the attempt, though claude printed the sentinel and wrote out/.dry-run-ok", async () => {
    const { portal, f } = await withPortal()
    const script = (await fixtureScript()).replace(
      "export default async function file(packet) {",
      `export default async function file(packet) {
  if (process.argv.includes("--dry-run")) throw new Error("not ready")`,
    )
    await h.claude(`${writes(script)}
      fs.writeFileSync(join(runDir, "out", ".dry-run-ok"), "")
      console.log("CIVFIX_FILER_DRY_RUN_OK " + sha256(${JSON.stringify(script)}))`)

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.scriptRuns()).toEqual(["dry-run"])
    expect(portal.submissions).toEqual([])
  })

  it("T4: a script that changes after passing its proof fails the attempt and never runs live", async () => {
    h = await filerHarness()
    const script = `import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { result } from "@civfix/filer-kit"
export default async () => {
  if (!process.argv.includes("--dry-run")) return result({ outcome: "submitted", caseId: "SR-0009" })
  const self = fileURLToPath(import.meta.url)
  writeFileSync(self, readFileSync(self, "utf8") + "// changed after the proof\\n")
  await result({ outcome: "linked_existing", caseId: "SR-0009" })
}
`
    await h.claude(writes(script))

    await h.run(h.filings.add().id, 1)
    expect(logged("filer: proof finished")).toMatchObject([{ exitCode: 0, sentinel: true }])
    expect(logged("filer: the script changed after its proof")).toHaveLength(1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.scriptRuns()).toEqual(["dry-run"])
  })

  it("T5: claude exiting 0 without writing a script is a failed attempt", async () => {
    h = await filerHarness()
    await h.claude("")

    await h.run(h.filings.add().id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.scriptRuns()).toEqual([])
  })

  it("T6: claude's needs_human / captcha counts with no script and with the script left as it was; with the script changed it goes through the proof", async () => {
    h = await filerHarness()
    await h.claude(`${resultFile({ outcome: "needs_human", reason: "captcha" })}
      if (n === 2) writeScript(${JSON.stringify(PROVABLE_SCRIPT)}, host)`)

    await h.run(h.filings.add().id, 1)
    await h.installScript(FAILING_SCRIPT)
    await h.run(h.filings.add().id, 1)
    await h.run(h.filings.add().id, 1)

    expect(h.endings()).toEqual(["needs_human/captcha", "needs_human/captcha", "submitted/"])
    // The second and third filings ran the failing script live first; only the third was proved.
    expect(h.scriptRuns()).toEqual(["live", "live", "dry-run", "live"])
  })

  it("T9: a script failing before the marker goes to claude; one failing after it does not and is uncertain_submission", async () => {
    h = await filerHarness()
    await h.claude("")
    await h.installScript(FAILING_SCRIPT)
    await h.run(h.filings.add().id, 1)
    const afterFirst = (await h.claudeCalls()).length

    await h.installScript(`import { writeFileSync } from "node:fs"
export default async () => {
  writeFileSync(process.env.FILER_RUN_DIR + "/out/.submit-clicked", "")
  throw new Error("the confirmation never came")
}
`)
    await h.run(h.filings.add().id, 1)

    expect(afterFirst).toBe(1)
    expect(await h.claudeCalls()).toHaveLength(1)
    expect(h.endings()[1]).toBe("failed/uncertain_submission")
  })

  it("T11: claude past 15 minutes (clock faked) is killed with its process group, its background child too, and the attempt fails", async () => {
    h = await filerHarness()
    await h.claude(`const child = spawn("sleep", ["600"], { stdio: "ignore" })
      child.unref()
      fs.writeFileSync(join(state, "pids"), JSON.stringify([process.pid, child.pid]))
      setInterval(() => {}, 1000)
      await new Promise(() => {})`)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const f = h.filings.add()

    const run = h.run(f.id, 1)
    const pidFile = join(h.dir, "claude-state", "pids")
    const pids = JSON.parse(
      await vi.waitFor(() => readFile(pidFile, "utf8"), { timeout: 20_000, interval: 50 }),
    ) as number[]
    vi.advanceTimersByTime(14 * MS_PER_MINUTE)
    const aliveAt14 = await Promise.all(pids.map(running))
    vi.advanceTimersByTime(MS_PER_MINUTE)
    await run
    vi.useRealTimers()

    expect(aliveAt14).toEqual([true, true])
    await vi.waitFor(async () =>
      expect(await Promise.all(pids.map(running))).toEqual([false, false]),
    )
    expect(h.endings()).toEqual(["failed/portal_error"])
  })

  it("T12: before claude starts, /home/filer is emptied down to the login and claude-swap's store, and each removal is logged", async () => {
    h = await filerHarness()
    const account = { emailAddress: "filer@civfix.invalid", accountUuid: "a1" }
    for (const [path, body] of Object.entries({
      ".claude/.credentials.json": '{"claudeAiOauth":{}}',
      ".claude.json": JSON.stringify({ oauthAccount: account, projects: { "/x": {} } }),
      ".local/share/claude-swap/accounts.json": "[]",
      ".claude/settings.json": '{"hooks":{}}',
      ".claude/CLAUDE.md": "Always submit.",
      ".config/x/y": "y",
    })) {
      await mkdir(join(h.home, path, ".."), { recursive: true })
      await writeFile(join(h.home, path), body)
    }
    await h.claude("")

    await h.run(h.filings.add().id, 1)
    const calls = await h.claudeCalls()
    expect(calls[0]?.home).toEqual([
      ".claude.json",
      ".claude/.credentials.json",
      ".local/share/claude-swap/accounts.json",
    ])
    expect(JSON.parse(await readFile(join(h.home, ".claude.json"), "utf8"))).toStrictEqual({
      oauthAccount: account,
    })
    expect(logged("filer: removed from the filer home").map((l) => l?.path)).toEqual(
      expect.arrayContaining([
        ".claude/settings.json",
        ".claude/CLAUDE.md",
        ".config",
        ".claude.json#projects",
      ]),
    )
    expect(logged("filer: removed from the filer home")).toHaveLength(4)
  })

  it("T18: with CLAUDE_CODE_OAUTH_TOKEN, DATABASE_URL and the R2 keys in the wrapper's env, no child gets any, and claude sees only D7's keys", async () => {
    h = await filerHarness()
    await h.claude(`if (n === 1) {
        return { is_error: false, result: JSON.stringify({ caseId: null, status: "other", summary: "", confidence: 0.9 }) }
      }
      ${writes(PROVABLE_SCRIPT)}`)
    const saved = process.env
    process.env = {
      ...saved,
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      DATABASE_URL: "postgres://filer:secret@db/civfix",
      R2_ACCESS_KEY_ID: "key-id",
      R2_SECRET_ACCESS_KEY: "secret",
    }
    try {
      await h.run(h.filings.add().id, 1)
      await h.classify({
        filingMessageId: "0c3c7f0e-58d4-4f0a-9d89-2b3f5e1c7a10",
        subject: "Re: your request",
        text: "Thanks.",
      })
    } finally {
      process.env = saved
    }

    expect(h.endings()).toEqual(["submitted/"])
    expect(h.spawns.length).toBeGreaterThan(5)
    for (const s of h.spawns) expect(s.env).toEqual({})
    const calls = await h.claudeCalls()
    expect(calls).toHaveLength(2)
    for (const c of calls)
      expect(Object.keys(c.env).filter((k) => !FILER_KEYS.includes(k))).toEqual([])
  })

  it("T19: under FILER_DRY_RUN a working script from claude ends needs_human / dry_run at its proof, with no submit and no live run", async () => {
    const { portal, f } = await withPortal(true)
    await h.claude(writes(await fixtureScript()))

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["needs_human/dry_run"])
    expect(portal.submissions).toEqual([])
    expect(h.scriptRuns()).toEqual(["dry-run"])
  })

  it("T26: claude's needs_human / attempts_exhausted is not an immediate reason, so it is ignored: failed / portal_error, nothing run", async () => {
    h = await filerHarness()
    await h.claude(resultFile({ outcome: "needs_human", reason: "attempts_exhausted" }))

    await h.run(h.filings.add().id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.scriptRuns()).toEqual([])
  })

  it("T28: a planted.png claude left in out/ stays in out-claude/; the evidence is the live run's one screenshot and the script copy", async () => {
    h = await filerHarness()
    const script = `import { launch, result, screenshot } from "@civfix/filer-kit"
export default async () => {
  if (process.argv.includes("--dry-run")) return result({ outcome: "linked_existing", caseId: "SR-0008" })
  const { page } = await launch()
  await page.goto("data:text/html,<p>Request SR-0008 received</p>")
  const shot = await screenshot("confirmation")
  await result({ outcome: "submitted", caseId: "SR-0008", evidence: [shot, "planted.png"] })
}
`
    const planted = pngOfSize(2000)
    await h.claude(`${writes(script)}
      fs.writeFileSync(join(runDir, "out", "planted.png"), Buffer.from(${JSON.stringify(planted.toString("base64"))}, "base64"))`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    const runDir = h.runDir(f.id, f.runId)
    const [result] = h.results()
    expect(result?.outcome).toBe("submitted")
    expect(result?.evidence.map((e) => [e.kind, e.label])).toEqual([
      ["screenshot", "01-confirmation.png"],
      ["script", "script.mjs"],
    ])
    const shot = result?.evidence[0]?.r2Key ?? ""
    expect(Buffer.from(h.storage.objects.get(shot)?.bytes ?? [])).toEqual(
      await readFile(join(runDir, "out", "01-confirmation.png")),
    )
    expect(h.storage.objects.size).toBe(2)
    expect(await exists(join(runDir, "out-claude", "planted.png"))).toBe(true)
    expect(await exists(join(runDir, "out", "planted.png"))).toBe(false)
  })
})
