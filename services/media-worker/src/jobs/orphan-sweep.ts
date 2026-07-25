/**
 * orphan.sweep cron: reap never-attached media.
 *
 * A media_assets row is created at upload time with no binding of any kind and gains one only when some
 * subject COMMITS it — a report, a chat/DM message, a social post, or an avatar/verification document
 * that points AT the row. A row that is STILL bound to nothing after the TTL is an orphan: the client
 * started an upload that never became anything. This sweep deletes the orphan's R2 objects (source +
 * legacy processed + thumbnail, all derivable from r2_key) and then the row.
 *
 * THE ORPHAN PREDICATE IS THE SAFETY BOUNDARY, AND IT LIVES IN THE REPO, NOT HERE — see
 * MediaWorkerRepo.findOrphans (services/api/src/services/media-worker-repo.ts) for the full lane
 * enumeration. This job trusts whatever findOrphans returns and destroys it, irreversibly: an
 * over-broad predicate here is not a recoverable bug. Anything added to the pipeline that can bind a
 * media row MUST be added to that predicate first.
 *
 * Safety/idempotency: storage deletes are idempotent on R2 (deleting a missing key is a no-op), and the
 * row delete is by id. A partial run (objects deleted, row delete fails) simply retries next sweep. We
 * page in bounded batches (orphanSweepBatch x orphanSweepMaxPages) so a backlog drains without one
 * giant transaction. NEVER throws: a per-row error is logged and the sweep continues.
 *
 * This is the plan's section-11 orphan sweep.
 */

import type { Storage } from "@civfix/shared/interfaces"
import type { MediaWorkerRepo, OrphanRow } from "@civfix/api/media-repo"
import type { WorkerLimits } from "../config.js"
import { thumbnailKey } from "./media-keys.js"

/** Bounded-concurrency map: at most `limit` of `fn` in flight at once. Preserves per-item isolation. */
async function mapWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item !== undefined) await fn(item)
    }
  })
  await Promise.all(runners)
}

/** Concurrent orphan rows processed per run (each is a chain of R2 + DB round-trips). */
const ORPHAN_CONCURRENCY = 8

export interface OrphanSweepDeps {
  repo: MediaWorkerRepo
  storage: Storage
  limits: WorkerLimits
  /** Injectable clock (defaults to Date.now) for deterministic tests. */
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
  report?: (err: unknown, context?: Record<string, unknown>) => void
}

export interface OrphanSweepResult {
  scanned: number
  deleted: number
  errors: number
}

/**
 * Keys to delete for an orphan: the source object (r2_key), the thumbnail the checks job writes, and any
 * LEGACY `processed/*` objects from before the worker switched to overwriting r2_key in place (it no
 * longer writes a separate processed object; older uploads may still have one). Deleting a missing key is
 * a no-op on R2, so listing the legacy keys is harmless cleanup.
 */
function derivedKeys(o: OrphanRow): string[] {
  const keys = [
    o.r2Key,
    // LEGACY processed/* objects from before the worker overwrote r2_key in place. Remove-after note:
    // safe to drop once no media_assets row predates that switch (deleting a missing key is a no-op).
    `processed/${o.r2Key}.img`,
    `processed/${o.r2Key}.mp4`,
    thumbnailKey(o.r2Key),
  ]
  if (o.thumbKey && !keys.includes(o.thumbKey)) keys.push(o.thumbKey)
  return keys
}

/**
 * Run one orphan sweep. Returns counts. Never throws; per-row failures are counted + logged + reported.
 */
export async function runOrphanSweep(deps: OrphanSweepDeps): Promise<OrphanSweepResult> {
  const log = deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {}))
  const report = deps.report ?? (() => {})
  const now = (deps.now ?? (() => new Date()))()
  const cutoff = new Date(now.getTime() - deps.limits.orphanTtlMs)

  let deleted = 0
  let errors = 0
  let scanned = 0

  // M10: DRAIN, don't nibble. The sweep used to reap ONE bounded batch per hourly run (200 rows)
  // against a presign rate limit that allows ~43,200 rows/day, so the orphan backlog could only grow
  // without bound — every never-committed upload accumulating in R2 forever. It now keeps paging while
  // a page comes back FULL (i.e. there is more work), bounded by orphanSweepMaxPages so one run cannot
  // monopolize the worker.
  for (let page = 0; page < deps.limits.orphanSweepMaxPages; page++) {
    let orphans: OrphanRow[]
    try {
      orphans = await deps.repo.findOrphans(cutoff, deps.limits.orphanSweepBatch)
    } catch (err) {
      report(err, { job: "orphan.sweep", phase: "find" })
      log("orphan.sweep: find failed", { err: String(err) })
      return { scanned, deleted, errors: errors + 1 }
    }
    if (orphans.length === 0) break
    scanned += orphans.length
    await sweepPage(orphans, deps, {
      onDeleted: () => deleted++,
      onError: (err, id) => {
        errors++
        report(err, { job: "orphan.sweep", phase: "delete", mediaId: id })
        log("orphan.sweep: row failed", { mediaId: id, err: String(err) })
      },
    })
    // A short page means the backlog is drained for this cutoff; stop rather than re-querying.
    if (orphans.length < deps.limits.orphanSweepBatch) break
  }

  log("orphan.sweep: done", {
    scanned,
    deleted,
    errors,
    cutoff: cutoff.toISOString(),
  })
  return { scanned, deleted, errors }
}

/** Reap one page of orphans. Never throws: per-row failures are reported through `hooks.onError`. */
async function sweepPage(
  orphans: OrphanRow[],
  deps: OrphanSweepDeps,
  hooks: { onDeleted: () => void; onError: (err: unknown, id: string) => void },
): Promise<void> {
  await mapWithLimit(orphans, ORPHAN_CONCURRENCY, async (o) => {
    try {
      // SECURITY: two media rows can point at the SAME r2_key, and all derivedKeys() are derived from
      // r2_key, so they are equally shared. Deleting them while ANOTHER row (e.g. a committed report's
      // media) still references the key would destroy live media.
      //
      // (L14 correction: this comment previously claimed r2_key is content-addressed as
      // `uploads/yyyy/mm/<sha256>`. It is not — buildR2Key in media-intake-service.ts uses the
      // server-generated random uploadId, so identical bytes do NOT dedupe to one object and the
      // "attacker uploads identical bytes to make the sweep nuke the victim's object" threat described
      // here never applied. The reference check below is still correct and still cheap, so it stays.)
      //
      // TOCTOU: delete the orphan ROW FIRST, then re-check r2KeyReferencedByOthers, then (only if still
      // unreferenced) delete the physical objects. With the old order (check -> delete R2 -> delete row) a
      // legit identical-bytes commit attaching a new row with the same key BETWEEN the check and the R2
      // delete would lose the shared object out from under the just-committed report. Checking AFTER the
      // row is gone means a concurrent commit that landed before our delete is seen and we skip the
      // physical delete (the surviving reference reclaims the object when it becomes the last one).
      await deps.repo.deleteById(o.id)
      const stillShared = await deps.repo.r2KeyReferencedByOthers(o.id, o.r2Key)
      if (!stillShared) {
        // The derived keys for one orphan are independent, so fire their R2 DELETEs in parallel.
        await Promise.all(derivedKeys(o).map((key) => deps.storage.delete(key)))
      }
      hooks.onDeleted()
    } catch (err) {
      hooks.onError(err, o.id)
    }
  })
}
