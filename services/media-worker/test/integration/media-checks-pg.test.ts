/**
 * Worker integration test (Docker-gated; SKIPS without Docker).
 *
 * Runs the FULL media.checks job against a live PostGIS database using the production Drizzle worker
 * repo (makeDrizzleMediaWorkerRepo) + FakeStorage + FakeAbuseChecks. Proves the real DB writes:
 *   - a valid image -> status ready, width/height/phash/thumb_key persisted.
 *   - a crafted bad image -> status rejected (safe failure end-to-end through Postgres).
 * Also exercises the orphan sweep and partition maintenance against real SQL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import {
  makeDrizzleMediaWorkerRepo,
  ensureNextMonthChatPartition,
  type MediaWorkerRepo,
} from "@civfix/api/media-repo"
import { loadLimits } from "../../src/config.js"
import { makeDownloader } from "../../src/download.js"
import { runMediaChecksJob } from "../../src/jobs/media-checks.js"
import { runOrphanSweep } from "../../src/jobs/orphan-sweep.js"
import { withWorkerPg, type WorkerPgHarness } from "../helpers/pg.js"
import * as fx from "../fixtures/make.js"
import { randomUUID } from "node:crypto"

const pg = await withWorkerPg()
const limits = loadLimits({})

describe.skipIf(!pg)("worker media.checks (integration)", () => {
  let h: WorkerPgHarness
  let repo: MediaWorkerRepo
  let storage: FakeStorage

  beforeAll(() => {
    h = pg as WorkerPgHarness
    repo = makeDrizzleMediaWorkerRepo(h.db)
    storage = new FakeStorage()
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function insertRow(kind: "image" | "video", r2Key: string): Promise<string> {
    const id = randomUUID()
    const uploadId = randomUUID()
    await h.sql`
      INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size)
      VALUES (${id}, ${uploadId}, ${kind}, ${r2Key}, 'validating', 0)
    `
    return id
  }

  it("valid image -> ready, dimensions + phash + thumb_key persisted", async () => {
    const r2Key = `uploads/2026/06/${randomUUID()}`
    const id = await insertRow("image", r2Key)
    const bytes = await fx.makeValidJpegWithGps()
    await storage.put(r2Key, bytes, { contentType: "image/jpeg" })

    const status = await runMediaChecksJob(
      { mediaId: id, uploadId: id, r2Key, kind: "image" },
      {
        repo,
        storage,
        abuseChecks: new FakeAbuseChecks(),
        limits,
        download: makeDownloader(storage),
        log: () => {},
      },
    )
    expect(status).toBe("ready")

    const [row] = await h.sql<
      { status: string; width: number; height: number; phash: string; thumb_key: string }[]
    >`SELECT status, width, height, phash, thumb_key FROM media_assets WHERE id = ${id}`
    expect(row!.status).toBe("ready")
    expect(row!.width).toBe(64)
    expect(row!.height).toBe(48)
    expect(row!.phash).toMatch(/^[0-9a-f]{16}$/)
    expect(row!.thumb_key).toBe(`thumbs/${r2Key}.jpg`)
  })

  it("crafted bad image -> rejected (safe failure through Postgres)", async () => {
    const r2Key = `uploads/2026/06/${randomUUID()}`
    const id = await insertRow("image", r2Key)
    await storage.put(r2Key, fx.makeGarbageImage(), { contentType: "image/jpeg" })

    const status = await runMediaChecksJob(
      { mediaId: id, uploadId: id, r2Key, kind: "image" },
      {
        repo,
        storage,
        abuseChecks: new FakeAbuseChecks(),
        limits,
        download: makeDownloader(storage),
        log: () => {},
        report: () => {},
      },
    )
    expect(status).toBe("rejected")
    const [row] = await h.sql<
      { status: string }[]
    >`SELECT status FROM media_assets WHERE id = ${id}`
    expect(row!.status).toBe("rejected")
  })

  it("orphan sweep deletes a never-attached, aged row", async () => {
    const r2Key = `uploads/2026/06/${randomUUID()}`
    const id = randomUUID()
    // created_at well in the past, report_id null.
    await h.sql`
      INSERT INTO media_assets (id, upload_id, kind, r2_key, status, created_at)
      VALUES (${id}, ${randomUUID()}, 'image', ${r2Key}, 'validating', now() - interval '2 days')
    `
    await storage.put(r2Key, Buffer.from([1, 2, 3]))

    const res = await runOrphanSweep({ repo, storage, limits, log: () => {} })
    expect(res.deleted).toBeGreaterThanOrEqual(1)
    const rows = await h.sql<{ id: string }[]>`SELECT id FROM media_assets WHERE id = ${id}`
    expect(rows.length).toBe(0)
  })

  it("partition maintenance creates next month's chat partition idempotently", async () => {
    const table = await ensureNextMonthChatPartition(h.sql, new Date("2026-06-15T00:00:00Z"))
    expect(table).toBe("chat_messages_2026_07")
    // Idempotent: a second call does not error.
    await expect(
      ensureNextMonthChatPartition(h.sql, new Date("2026-06-15T00:00:00Z")),
    ).resolves.toBe("chat_messages_2026_07")
    // The partition exists in the catalog.
    const [exists] = await h.sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.chat_messages_2026_07') IS NOT NULL AS exists
    `
    expect(exists!.exists).toBe(true)
  })
})
