import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PROVABLE_SCRIPT, writes } from "../helpers/claude-acts.js"
import { PORTAL_HOST } from "../helpers/fake-filings-worker.js"
import { filerHarness, testGit, type FilerHarness } from "../helpers/filer-harness.js"
import { exists } from "../helpers/files.js"

/** Every child process this test process starts, whichever child_process function starts it. */
const started = vi.hoisted(() => [] as { command: string; args: unknown }[])

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => unknown>>()
  const names = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]
  const wrapped = Object.fromEntries(
    names.map((name) => [
      name,
      (command: string, ...rest: unknown[]) => {
        started.push({ command, args: rest[0] })
        return actual[name]?.(command, ...rest)
      },
    ]),
  )
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } }
})

let h: FilerHarness

afterEach(async () => {
  await h?.close()
})

const ORIGINAL = "export default async () => { /* other.example */ }\n"

/** Another host's script, committed before the run. */
async function otherHostCommitted(): Promise<string> {
  const other = join(h.workspace, "portals", "other.example")
  await mkdir(other, { recursive: true })
  await writeFile(join(other, "script.mjs"), ORIGINAL)
  testGit(h.workspace, "add", "-A")
  testGit(h.workspace, "commit", "--quiet", "-m", "other.example")
  return other
}

const reverted = () =>
  h.logs
    .filter((l) => l.line === "filer: reverted an out-of-scope change")
    .map((l) => l.fields?.path)

describe("confinement and the wrapper's git", () => {
  it("T7: another host's committed edit and its file hidden by a new .gitignore are reverted and logged in a revert commit; this host's script stays", async () => {
    h = await filerHarness()
    const other = await otherHostCommitted()
    await h.claude(`${writes(PROVABLE_SCRIPT)}
      const other = join(workspace, "portals", "other.example")
      fs.writeFileSync(join(other, "script.mjs"), "export default async () => { /* hijacked */ }\\n")
      git("add", "-A")
      git("commit", "--quiet", "-m", "${PORTAL_HOST} and other.example")
      fs.writeFileSync(join(other, ".gitignore"), "x.mjs\\n")
      fs.writeFileSync(join(other, "x.mjs"), "export default 1\\n")`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    expect(await readFile(join(other, "script.mjs"), "utf8")).toBe(ORIGINAL)
    expect(await exists(join(other, "x.mjs"))).toBe(false)
    expect(await exists(join(other, ".gitignore"))).toBe(false)
    expect(reverted()).toEqual([
      "portals/other.example/.gitignore",
      "portals/other.example/script.mjs",
      "portals/other.example/x.mjs",
    ])
    expect(testGit(h.workspace, "log", "-1", "--format=%s")).toBe(
      `Revert out-of-scope changes (filing ${f.id})\n`,
    )
    expect(testGit(h.workspace, "show", "--name-only", "--format=", "HEAD")).toBe(
      "portals/other.example/script.mjs\n",
    )
    expect(testGit(h.workspace, "show", "HEAD:portals/other.example/script.mjs")).toBe(ORIGINAL)
    expect(await readFile(join(h.workspace, "portals", PORTAL_HOST, "script.mjs"), "utf8")).toBe(
      PROVABLE_SCRIPT,
    )
    expect(h.endings()).toEqual(["submitted/"])
  })

  it("T8: hooks in .git/hooks and core.hooksPath, and a core.fsmonitor, run on none of the wrapper's git calls, all started through filer-shell", async () => {
    h = await filerHarness()
    await otherHostCommitted()
    const markers = join(h.dir, "markers")
    await mkdir(markers)
    // Claude commits an out-of-scope edit, so the wrapper checks out and commits, then plants the hooks.
    await h.claude(`${writes(PROVABLE_SCRIPT)}
      fs.writeFileSync(join(workspace, "portals", "other.example", "script.mjs"), "changed\\n")
      git("add", "-A")
      git("commit", "--quiet", "-m", "claude")
      const hook = (name) => "#!/bin/sh\\ntouch ${markers}/" + name + "\\n"
      for (const dir of ["hooks", "evil"]) {
        fs.mkdirSync(join(workspace, ".git", dir), { recursive: true })
        for (const name of ["post-checkout", "pre-commit", "commit-msg", "post-commit", "reference-transaction"]) {
          fs.writeFileSync(join(workspace, ".git", dir, name), hook(dir + "-" + name), { mode: 0o755 })
        }
      }
      fs.writeFileSync(join(workspace, ".git", "fsmonitor"), hook("fsmonitor"), { mode: 0o755 })
      git("config", "core.hooksPath", ".git/evil")
      git("config", "core.fsmonitor", join(workspace, ".git", "fsmonitor"))`)
    const f = h.filings.add()
    started.length = 0

    await h.run(f.id, 1)
    expect(await readdir(markers)).toEqual([])
    const ownGit = started.filter((c) => /(^|\/)git(\s|$)/.test(c.command))
    expect(ownGit).toEqual([])
    const gitSpawns = h.spawns.filter((s) => s.args.includes("git"))
    expect(gitSpawns.length).toBeGreaterThan(3)
    for (const s of gitSpawns) {
      expect(s.command).toBe(h.runner.filerShell)
      expect(s.args.slice(0, s.args.indexOf("git") + 1)).toEqual([
        ...["--", "env", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "git"],
      ])
      expect(s.args).toEqual(
        expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false"]),
      )
    }
    expect(testGit(h.workspace, "-c", "core.fsmonitor=false", "log", "-1", "--format=%s")).toBe(
      `Revert out-of-scope changes (filing ${f.id})\n`,
    )
  })
})

/** The revert commit's message: its subject, then each reverted path. */
const revertMessage = () => testGit(h.workspace, "log", "-1", "--format=%B")

const OTHER_SCRIPT = "portals/other.example/script.mjs"

describe("confinement that nothing in .git can fool", () => {
  it("T36: an edit hidden by skip-worktree, then one hidden by assume-unchanged, is put back to base's bytes and logged in the revert commit", async () => {
    const outcomes = []
    for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
      h = await filerHarness()
      const other = await otherHostCommitted()
      await h.claude(`${writes(PROVABLE_SCRIPT)}
      git("update-index", "${flag}", "${OTHER_SCRIPT}")
      fs.writeFileSync(join(workspace, "${OTHER_SCRIPT}"), "export default async () => { /* hijacked */ }\\n")`)
      const f = h.filings.add()

      await h.run(f.id, 1)
      outcomes.push({
        flag,
        bytes: await readFile(join(other, "script.mjs"), "utf8"),
        logged: reverted(),
        message: revertMessage(),
      })
      await h.close()
    }

    expect(outcomes).toEqual(
      ["--skip-worktree", "--assume-unchanged"].map((flag) => ({
        flag,
        bytes: ORIGINAL,
        logged: [OTHER_SCRIPT],
        message: expect.stringMatching(
          /^Revert out-of-scope changes \(filing [^)]+\)\n\n.*portals\/other\.example\/script\.mjs\n/s,
        ),
      })),
    )
  })

  it("T37: a core.worktree pointing at a copy of portals/ as it was at base hides nothing; every wrapper git call names the workspace's git dir and work tree", async () => {
    h = await filerHarness()
    const other = await otherHostCommitted()
    const shadow = join(h.dir, "shadow")
    await mkdir(join(shadow, "portals", "other.example"), { recursive: true })
    await writeFile(join(shadow, OTHER_SCRIPT), ORIGINAL)
    await h.claude(`${writes(PROVABLE_SCRIPT)}
      git("config", "core.worktree", ${JSON.stringify(shadow)})
      fs.writeFileSync(join(workspace, "${OTHER_SCRIPT}"), "export default async () => { /* hijacked */ }\\n")`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    expect(await readFile(join(other, "script.mjs"), "utf8")).toBe(ORIGINAL)
    expect(reverted()).toEqual([OTHER_SCRIPT])
    expect(revertMessage()).toContain(OTHER_SCRIPT)
    const gitSpawns = h.spawns.filter((s) => s.args.includes("git"))
    expect(gitSpawns.length).toBeGreaterThan(3)
    for (const s of gitSpawns) {
      expect(s.args).toEqual(
        expect.arrayContaining([
          `--git-dir=${join(h.workspace, ".git")}`,
          `--work-tree=${h.workspace}`,
        ]),
      )
    }
  })

  it("T38: a committed edit with a stale .git/index.lock left behind is put back to base's bytes and logged in the revert commit", async () => {
    h = await filerHarness()
    const other = await otherHostCommitted()
    await h.claude(`${writes(PROVABLE_SCRIPT)}
      fs.writeFileSync(join(workspace, "${OTHER_SCRIPT}"), "export default async () => { /* hijacked */ }\\n")
      git("add", "-A")
      git("commit", "--quiet", "-m", "claude")
      fs.writeFileSync(join(workspace, ".git", "index.lock"), "")`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    expect(await readFile(join(other, "script.mjs"), "utf8")).toBe(ORIGINAL)
    expect(reverted()).toEqual([OTHER_SCRIPT])
    expect(revertMessage()).toMatch(/^Revert out-of-scope changes/)
    expect(revertMessage()).toContain(OTHER_SCRIPT)
    expect(testGit(h.workspace, "show", `HEAD:${OTHER_SCRIPT}`)).toBe(ORIGINAL)
  })

  it("T39: a clean filter set through .git/info/attributes that prints base's bytes hides nothing", async () => {
    h = await filerHarness()
    const other = await otherHostCommitted()
    const baseCopy = join(h.dir, "base-copy.mjs")
    await writeFile(baseCopy, ORIGINAL)
    await h.claude(`${writes(PROVABLE_SCRIPT)}
      fs.mkdirSync(join(workspace, ".git", "info"), { recursive: true })
      fs.writeFileSync(join(workspace, ".git", "info", "attributes"), "* filter=x\\n")
      git("config", "filter.x.clean", "cat ${baseCopy}")
      fs.writeFileSync(join(workspace, "${OTHER_SCRIPT}"), "export default async () => { /* hijacked */ }\\n")`)
    const f = h.filings.add()

    await h.run(f.id, 1)
    expect(await readFile(join(other, "script.mjs"), "utf8")).toBe(ORIGINAL)
    expect(reverted()).toEqual([OTHER_SCRIPT])
  })

  it("T40: when the restoring git call fails, other.example loses its proved record, logged; failed / portal_error and no live run", async () => {
    h = await filerHarness()
    await otherHostCommitted()
    await h.prove(undefined, "other.example")
    await h.claude(`${writes(PROVABLE_SCRIPT)}
      fs.writeFileSync(join(workspace, "${OTHER_SCRIPT}"), "export default async () => { /* hijacked */ }\\n")`)
    h.failing.when = (args) => args.includes("cat-file")
    const f = h.filings.add()

    await h.run(f.id, 1)
    expect(await h.proved("other.example")).toBeNull()
    expect(
      h.logs.filter(
        (l) => l.line === "filer: proved record deleted" && l.fields?.host === "other.example",
      ),
    ).toHaveLength(1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.steps()).not.toContain("live")
  })

  it("a portals/ node can't list, with a shadow kit planted in other.example's folder, deletes every proved record; failed / portal_error", async () => {
    h = await filerHarness()
    await otherHostCommitted()
    await h.prove(undefined, "other.example")
    await h.prove("export default async () => {}\n", "third.example")
    await h.claude(`${writes(PROVABLE_SCRIPT)}
      const kit = join(workspace, "portals", "other.example", "node_modules", "@civfix", "filer-kit")
      fs.mkdirSync(kit, { recursive: true })
      fs.writeFileSync(join(kit, "index.js"), 'export const marker = "PLANTED KIT"\\n')
      fs.chmodSync(join(workspace, "portals"), 0o300)`)
    const f = h.filings.add()

    try {
      await h.run(f.id, 1)
    } finally {
      await chmod(join(h.workspace, "portals"), 0o770)
    }
    expect(await h.proved("other.example")).toBeNull()
    expect(await h.proved("third.example")).toBeNull()
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.steps()).not.toContain("live")
  })
})
