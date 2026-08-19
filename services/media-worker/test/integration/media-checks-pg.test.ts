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

  /**
   * REGRESSION against the REAL SQL (blocker): the predicate was `report_id IS NULL` alone, and every
   * non-report lane leaves report_id NULL, so the first sweep after deploy would have deleted every user
   * avatar, every social-post photo and every chat/DM attachment older than the TTL — rows AND R2
   * objects, with avatar_media_id silently NULLed by its ON DELETE SET NULL FK.
   *
   * The unit test covers the same lanes through the in-memory fake; this one is the version that can
   * actually catch a mistake in the generated SQL (a mistyped column, a NOT EXISTS that correlates
   * wrongly), because it runs against the canonical migrated schema.
   */
  it("orphan sweep never reaps a BOUND row (chat / post / avatar / verification lanes)", async () => {
    // Aged 2 days: every row below is far past the TTL, so only the binding can save it.
    async function insertAged(
      cols: { chatMessageId?: string; postId?: string; purpose?: string } = {},
    ): Promise<{ id: string; r2Key: string }> {
      const id = randomUUID()
      const r2Key = `uploads/2026/06/${randomUUID()}`
      await h.sql`
        INSERT INTO media_assets (id, upload_id, kind, r2_key, status, purpose, chat_message_id, post_id, created_at)
        VALUES (
          ${id}, ${randomUUID()}, 'image', ${r2Key}, 'ready', ${cols.purpose ?? "report"},
          ${cols.chatMessageId ?? null}, ${cols.postId ?? null}, now() - interval '2 days'
        )
      `
      await storage.put(r2Key, Buffer.from([1, 2, 3]))
      return { id, r2Key }
    }

    // users.handle is NOT NULL with a CHECK on ^[A-Za-z0-9_]{3,20}$ since 0026 - omitting it made this
    // whole case fail before it could assert anything.
    const [owner] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Orphan Lane Owner', 'orphanlaneowner')
      RETURNING id
    `
    const [post] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, body) VALUES (${owner!.id}, 'lane test') RETURNING id
    `

    // chat_message_id is a BARE uuid (the message tables are partitioned, so there is no FK), which is
    // exactly why the attach guard requires report_id IS NULL and why these rows matched the old predicate.
    const chatBound = await insertAged({ chatMessageId: randomUUID() })
    const postBound = await insertAged({ postId: post!.id, purpose: "post" })
    const verification = await insertAged({ purpose: "verification" })
    const userAvatar = await insertAged()
    const groupAvatar = await insertAged()

    // REVERSE bindings: the subject points AT the media row, so the row's own columns stay NULL.
    await h.sql`UPDATE users SET avatar_media_id = ${userAvatar.id} WHERE id = ${owner!.id}`
    await h.sql`
      INSERT INTO chat_groups (name, owner_id, avatar_media_id)
      VALUES ('Orphan Lane Group', ${owner!.id}, ${groupAvatar.id})
    `

    // A genuine orphan in the same run, so a predicate that matched nothing would not pass either.
    const orphan = await insertAged()

    const res = await runOrphanSweep({ repo, storage, limits, log: () => {} })
    expect(res.errors).toBe(0)

    const survivors = [chatBound, postBound, verification, userAvatar, groupAvatar]
    const ids = survivors.map((s) => s.id)
    const kept = await h.sql<{ id: string }[]>`
      SELECT id FROM media_assets WHERE id IN ${h.sql(ids)}
    `
    expect(kept.map((r) => r.id).sort()).toEqual([...ids].sort())
    for (const s of survivors) expect(storage.get(s.r2Key)).not.toBeNull()

    // The avatar FK is ON DELETE SET NULL, so a wrong predicate would show up here as a NULLed column
    // rather than as an error anywhere.
    const [ownerRow] = await h.sql<{ avatar_media_id: string | null }[]>`
      SELECT avatar_media_id FROM users WHERE id = ${owner!.id}
    `
    expect(ownerRow!.avatar_media_id).toBe(userAvatar.id)

    // ...and the real orphan is gone, row and bytes.
    const gone = await h.sql<{ id: string }[]>`SELECT id FROM media_assets WHERE id = ${orphan.id}`
    expect(gone.length).toBe(0)
    expect(storage.get(orphan.r2Key)).toBeNull()
  })

  /**
   * The 21000 guard in recordLeakedObjects, against the real statement.
   *
   * It is ONE multi-row `INSERT ... ON CONFLICT (r2_key) DO UPDATE`, and Postgres aborts such a statement
   * with 21000 ("ON CONFLICT DO UPDATE command cannot affect row a second time") when one of its rows
   * repeats the conflict target — which is why the impl collapses `keys` to a Set first. This write is the
   * ONLY record of a leak whose media row has already been deleted, so a throw here strands the object in
   * the bucket permanently. Nothing exercised the dedupe on either side of the seam.
   */
  it("F087b: findStuckValidating skips never-finalized intents, rotates oldest-checked-first, and counts picks", async () => {
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const cutoff = new Date(Date.now() - 60 * 60 * 1000)

    async function seedStuck(finalized: boolean, checkedAt: Date | null): Promise<string> {
      const id = randomUUID()
      const uploadId = randomUUID()
      await h.sql`
        INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size, created_at,
                                  finalized_at, stuck_checked_at)
        VALUES (${id}, ${uploadId}, 'image', ${`uploads/stuck/${id}`}, 'validating', 0, ${old},
                ${finalized ? old : null}, ${checkedAt})
      `
      return id
    }

    // Only rows the API actually FINALIZED are in scope: a row is created 'validating' at PRESIGN time,
    // so an unfinalized one is an upload intent whose bytes never arrived — the orphan sweep's job.
    const neverFinalized = await seedStuck(false, null)
    const checkedRecently = await seedStuck(true, new Date(Date.now() - 60_000))
    const neverChecked = await seedStuck(true, null)

    const first = await repo.findStuckValidating(cutoff, 1)
    expect(first.map((r) => r.id)).toEqual([neverChecked])
    expect(first[0]!.checkCount).toBe(1)

    // The pick stamped stuck_checked_at, so the next run serves the OTHER row: no permanent resident can
    // pin the batch and starve the rest (the starvation 0088 fixed for hold-release).
    const second = await repo.findStuckValidating(cutoff, 1)
    expect(second.map((r) => r.id)).toEqual([checkedRecently])
    expect(second[0]!.checkCount).toBe(1)

    const third = await repo.findStuckValidating(cutoff, 1)
    expect(third.map((r) => r.id)).toEqual([neverChecked])
    expect(third[0]!.checkCount).toBe(2)

    const [intent] = await h.sql<{ stuck_check_count: number }[]>`
      SELECT stuck_check_count FROM media_assets WHERE id = ${neverFinalized}
    `
    expect(intent!.stuck_check_count).toBe(0)
  })

  it("F087d: findStuckValidating is keyed on finalized_at age, so a LATE-finalized row is not instantly stuck", async () => {
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const cutoff = new Date(Date.now() - 60 * 60 * 1000)

    async function seedFinalizedAt(finalizedAt: Date): Promise<string> {
      const id = randomUUID()
      await h.sql`
        INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size, created_at, finalized_at)
        VALUES (${id}, ${randomUUID()}, 'image', ${`uploads/late/${id}`}, 'validating', 0, ${old}, ${finalizedAt})
      `
      return id
    }

    // Both rows were PRESIGNED a day ago; only one has owed a verdict for longer than the TTL. Keyed on
    // created_at (the old predicate) the late-finalized upload was stuck the instant it finalized, and
    // burned its whole attempt budget while the worker was still on its first pass.
    const lateFinalized = await seedFinalizedAt(new Date(Date.now() - 60_000))
    const genuinelyStuck = await seedFinalizedAt(old)

    const picked = await repo.findStuckValidating(cutoff, 10)
    const ids = picked.map((r) => r.id)
    expect(ids).toContain(genuinelyStuck)
    expect(ids).not.toContain(lateFinalized)

    const [late] = await h.sql<{ stuck_check_count: number }[]>`
      SELECT stuck_check_count FROM media_assets WHERE id = ${lateFinalized}
    `
    expect(late!.stuck_check_count).toBe(0)
  })

  it("F087d: applyResult is a CAS on 'validating' - a terminal row is never re-opened by a late job", async () => {
    const id = randomUUID()
    const r2Key = `uploads/2026/06/${randomUUID()}`
    await h.sql`
      INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size)
      VALUES (${id}, ${randomUUID()}, 'image', ${r2Key}, 'validating', 0)
    `

    const won = await repo.applyResult(id, { status: "ready", width: 10, height: 20 })
    expect(won?.status).toBe("ready")

    // The stuck sweep terminalized this row and deleted its objects; a media.checks job that finished a
    // moment later must NOT flip it back to ready — that asset would presign a 404 forever.
    await h.sql`UPDATE media_assets SET status = 'rejected' WHERE id = ${id}`
    expect(await repo.applyResult(id, { status: "ready", width: 99 })).toBeNull()

    const [row] = await h.sql<{ status: string; width: number }[]>`
      SELECT status, width FROM media_assets WHERE id = ${id}
    `
    expect(row!.status).toBe("rejected")
    expect(row!.width).toBe(10)
  })

  it("F087b: the claim cannot steal a row another writer is finishing, and the give-up is a CAS on 'validating'", async () => {
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const cutoff = new Date(Date.now() - 60 * 60 * 1000)
    const id = randomUUID()
    const uploadId = randomUUID()
    await h.sql`
      INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size, created_at, finalized_at)
      VALUES (${id}, ${uploadId}, 'image', ${`uploads/race/${id}`}, 'validating', 0, ${old}, ${old})
    `

    // A concurrent media.checks handler is mid-write on this exact row. The sweep's claim takes
    // FOR UPDATE SKIP LOCKED, so it steps over the locked row instead of blocking on it and then
    // overwriting the terminal status the other writer is about to commit.
    let commit = (): void => {}
    const held = new Promise<void>((resolve) => {
      commit = resolve
    })
    const writer = h.sql.begin(async (tx) => {
      await tx`UPDATE media_assets SET status = 'ready' WHERE id = ${id}`
      await held
    })
    await new Promise((r) => setTimeout(r, 150))
    const duringLock = await repo.findStuckValidating(cutoff, 10)
    expect(duringLock.map((r) => r.id)).not.toContain(id)
    commit()
    await writer

    // ...and once that writer committed, the row is no longer 'validating', so neither the claim nor the
    // give-up can touch it. A terminal status the sweep never observed is never clobbered.
    const afterCommit = await repo.findStuckValidating(cutoff, 10)
    expect(afterCommit.map((r) => r.id)).not.toContain(id)
    expect(await repo.terminalizeStuck(id)).toBeNull()
    const [row] = await h.sql<{ status: string }[]>`SELECT status FROM media_assets WHERE id = ${id}`
    expect(row!.status).toBe("ready")
  })

  it("records a duplicated leaked key ONCE instead of aborting with 21000", async () => {
    const key = `uploads/2026/06/${randomUUID()}`
    const mediaId = randomUUID()

    await expect(
      repo.recordLeakedObjects?.({ mediaId, keys: [key, key], error: "storage delete failed" }),
    ).resolves.toBeUndefined()

    const [row] = await h.sql<{ attempts: number; last_error: string | null }[]>`
      SELECT attempts, last_error FROM media_reap_tombstones WHERE r2_key = ${key}
    `
    expect(row).toMatchObject({ attempts: 1, last_error: "storage delete failed" })

    // A SEPARATE call is a genuine retry and must bump — the upsert half of the same statement.
    await repo.recordLeakedObjects?.({ mediaId, keys: [key], error: "still failing" })
    const [bumped] = await h.sql<{ attempts: number; last_error: string | null }[]>`
      SELECT attempts, last_error FROM media_reap_tombstones WHERE r2_key = ${key}
    `
    expect(bumped).toMatchObject({ attempts: 2, last_error: "still failing" })

    await repo.clearLeakedObject?.(key)
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
