import { mkdir, readdir, readFile, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { errorResult } from "../helpers/claude-acts.js"
import { PORTAL_HOST } from "../helpers/fake-filings-worker.js"
import { CONTACT, filerHarness, type FilerHarness } from "../helpers/filer-harness.js"
import { exists, jpegOfSize, MB, mode } from "../helpers/files.js"

let h: FilerHarness

afterEach(async () => {
  await h?.close()
})

const runs = () => readdir(join(h.workspace, "runs"))

/** A script that would run if the handler spawned it. */
const SCRIPT = "export default async () => {}"

describe("the filing.run job handler", () => {
  it("T1: claims attempt 1 of a queued filing and runs it in runs/<id>-<runId>/", async () => {
    h = await filerHarness()
    const f = h.filings.add({ attempts: 0 })

    expect(await h.run(f.id, 1)).toBe("completed")

    expect(f.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await runs()).toEqual([`${f.id}-${f.runId}`])
    expect(await exists(join(h.runDir(f.id, f.runId), "packet.json"))).toBe(true)
    expect(h.results().map((r) => [r.runId, r.attempt])).toEqual([[f.runId, 1]])
  })

  it("T2: a job for an attempt the filing already ran completes with no run directory and no result", async () => {
    h = await filerHarness()
    const f = h.filings.add({ attempts: 1 })

    expect(await h.run(f.id, 1)).toBe("completed")
    expect(await runs()).toEqual([])
    expect(h.results()).toEqual([])
  })

  it("T3: while paused the job completes, the filing stays queued and no run directory is made", async () => {
    h = await filerHarness()
    h.filings.paused = true
    const f = h.filings.add()

    expect(await h.run(f.id, 1)).toBe("completed")
    expect(f.status).toBe("queued")
    expect(await runs()).toEqual([])
    expect(h.results()).toEqual([])
  })

  it("T4: a report that is no longer fileable gets a cancelled result and nothing is spawned", async () => {
    h = await filerHarness()
    await h.installScript(SCRIPT)
    const f = h.filings.add({ fileable: false })

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["cancelled/"])
    expect(h.spawnEnvs).toEqual([])
  })

  it("T5: a run directory that already exists for the claimed run is a failed result and is left empty", async () => {
    h = await filerHarness()
    await h.installScript(SCRIPT)
    const f = h.filings.add()
    h.filings.nextRunIds.push("7f1c0a52-3c39-4f3e-9d2a-0f0e6f1d2a11")
    await mkdir(h.runDir(f.id, "7f1c0a52-3c39-4f3e-9d2a-0f0e6f1d2a11"))

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(await readdir(h.runDir(f.id, f.runId))).toEqual([])
    expect(h.spawnEnvs).toEqual([])
  })

  it("T6: the run directory is 0750, packet.json 0640, photos/ 0750 with 0640 files, out/ 2770", async () => {
    h = await filerHarness()
    await h.storage.put("media/a.jpg", jpegOfSize(1000))
    const f = h.filings.add({
      media: [{ servedKey: "media/a.jpg", byteSize: 1000, kind: "image" }],
    })

    await h.run(f.id, 1)
    const dir = h.runDir(f.id, f.runId)
    const entries = ["", "packet.json", "photos", "out"].map((e) => join(dir, e))
    const photos = (await readdir(join(dir, "photos"))).map((p) => join(dir, "photos", p))
    expect(await Promise.all([...entries, ...photos].map(mode))).toEqual([
      0o750, 0o640, 0o750, 0o2770, 0o640,
    ])
    // In the image every entry belongs to the filer group; outside it there is no such group.
    for (const e of h.config.filerGid === null ? [] : entries) {
      expect((await stat(e)).gid).toBe(h.config.filerGid)
    }
  })

  it("T7: packet.json is exactly D7's keys, dryRun false and the org contact, nothing of the reporter", async () => {
    h = await filerHarness()
    const f = h.filings.add()

    await h.run(f.id, 1)
    const raw = await readFile(join(h.runDir(f.id, f.runId), "packet.json"), "utf8")
    expect(JSON.parse(raw)).toStrictEqual({
      ticketText: f.packet.ticketText,
      location: { addr: f.packet.addr, lat: f.packet.lat, lng: f.packet.lng },
      category: f.packet.category,
      requestTypeHint: f.packet.requestTypeHint,
      startUrl: f.packet.formUrl,
      contact: CONTACT,
      dryRun: false,
    })
  })

  it("T8: photos/ gets the 3 and 2 MB photos, not the 11 MB one and never the video", async () => {
    h = await filerHarness()
    const media = [
      { servedKey: "media/p3.jpg", byteSize: 3 * MB, kind: "image" as const },
      { servedKey: "media/p11.jpg", byteSize: 11 * MB, kind: "image" as const },
      { servedKey: "media/v.mp4", byteSize: MB, kind: "video" as const },
      { servedKey: "media/p2.jpg", byteSize: 2 * MB, kind: "image" as const },
    ]
    for (const m of media) await h.storage.put(m.servedKey, jpegOfSize(m.byteSize))
    const f = h.filings.add({ media })

    await h.run(f.id, 1)
    const dir = join(h.runDir(f.id, f.runId), "photos")
    const names = (await readdir(dir)).sort()
    expect(await Promise.all(names.map(async (n) => (await stat(join(dir, n))).size))).toEqual([
      3 * MB,
      2 * MB,
    ])
  })

  it("T19: a script symlinked to /proc/self/environ, then a host directory symlinked to /etc, fail with nothing read, uploaded or spawned", async () => {
    h = await filerHarness()
    await mkdir(join(h.workspace, "portals", PORTAL_HOST))
    await symlink("/proc/self/environ", join(h.workspace, "portals", PORTAL_HOST, "script.mjs"))
    await h.run(h.filings.add().id, 1)
    await symlink("/etc", join(h.workspace, "portals", "etc.test"))
    await h.run(
      h.filings.add({ packet: { portalHost: "etc.test", formUrl: "https://etc.test/" } }).id,
      1,
    )

    expect(h.endings()).toEqual(["failed/portal_error", "failed/portal_error"])
    expect(h.results().map((r) => [r.evidence, r.scriptVersion])).toEqual([
      [[], undefined],
      [[], undefined],
    ])
    expect(h.storage.objects.size).toBe(0)
    expect(h.spawnEnvs).toEqual([])
  })

  it("T20: with no script it is failed / ai_unavailable, and the requeued job's new run gets a fresh directory", async () => {
    h = await filerHarness()
    // No script goes to Claude (#177); here both accounts are out of usage.
    await h.claude(errorResult("usage limit reached"))
    const f = h.filings.add()
    await h.run(f.id, 1)
    const first = f.runId
    // The API requeues ai_unavailable without spending the attempt.
    Object.assign(f, { status: "queued", attempts: 0 })
    await h.run(f.id, 1)

    expect(h.endings()).toEqual(["failed/ai_unavailable", "failed/ai_unavailable"])
    expect(h.results().map((r) => r.runId)).toEqual([first, f.runId])
    expect((await runs()).sort()).toEqual([`${f.id}-${first}`, `${f.id}-${f.runId}`].sort())
    expect(f.runId).not.toBe(first)
  })

  it("T33: a script of 1 MB + 1 byte is failed / portal_error with nothing uploaded or spawned", async () => {
    h = await filerHarness()
    await h.installScript(Buffer.alloc(MB + 1, 0x20))

    await h.run(h.filings.add().id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(h.storage.objects.size).toBe(0)
    expect(h.spawnEnvs).toEqual([])
  })
})
