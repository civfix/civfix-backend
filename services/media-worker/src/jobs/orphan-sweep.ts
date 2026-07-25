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
 * row delete is by id. The row is deleted BEFORE the objects (a TOCTOU fix, see sweepPage), so a partial
 * run leaks objects rather than rows — those keys are TOMBSTONED (media_reap_tombstones, drizzle/0057) and
 * retried at the start of a later run, bounded by LEAK_RETRY_MAX_ATTEMPTS. We page in bounded batches
 * (orphanSweepBatch x orphanSweepMaxPages) so a backlog drains without one giant transaction.
 * NEVER throws: a per-row error is logged and the sweep continues.
 *
 * This is the plan's section-11 orphan sweep.
 */

import type { Storage } from "@civfix/shared/interfaces"
import type { LeakedObjectRow, MediaWorkerRepo, OrphanRow } from "@civfix/api/media-repo"
import type { WorkerLimits } from "../config.js"
import { drainPages } from "./drain.js"
import { resolveJobObs, type JobObsDeps, type JobLogFn, type JobReportFn } from "./obs.js"
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

/**
 * Failed delete attempts after which a tombstoned key stops being retried (drizzle/0057). The row is then
 * LEFT IN PLACE as the operator-visible record of a permanent leak — deleting it would be the same amnesia
 * the tombstone exists to prevent. 5 hourly retries is generous for a transient R2 fault (the AWS SDK has
 * already retried internally before we ever see a failure); past that it is a bucket/permission problem no
 * amount of retrying fixes.
 */
export const LEAK_RETRY_MAX_ATTEMPTS = 5

/** Tombstones retried per sweep run. Bounds the pre-drain work so it cannot crowd out the reap itself. */
const LEAK_RETRY_LIMIT = 200

export interface OrphanSweepDeps extends JobObsDeps {
  repo: MediaWorkerRepo
  storage: Storage
  limits: WorkerLimits
}

export interface OrphanSweepResult {
  scanned: number
  deleted: number
  errors: number
  /** R2 objects whose row was reaped but whose physical delete failed (tombstoned; see deleteObjects). */
  leaked: number
  /** Tombstoned keys from earlier runs this run re-attempted. */
  retried: number
  /** Tombstoned keys this run finally deleted (tombstone dropped). */
  reclaimed: number
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
  const { log, report, now: clock } = resolveJobObs(deps)
  const cutoff = new Date(clock().getTime() - deps.limits.orphanTtlMs)

  let deleted = 0
  let errors = 0
  let scanned = 0
  let leaked = 0

  // Retry the objects EARLIER runs failed to delete, before reaping anything new: a key tombstoned by this
  // run has just failed a delete, so retrying it in the same run only burns an attempt.
  const retry = await retryTombstonedLeaks(deps, log, report)
  errors += retry.errors

  // M10: DRAIN, don't nibble. The sweep used to reap ONE bounded batch per hourly run (200 rows)
  // against a presign rate limit that allows ~43,200 rows/day, so the orphan backlog could only grow
  // without bound — every never-committed upload accumulating in R2 forever. It now keeps paging while
  // a page comes back FULL (i.e. there is more work), bounded by orphanSweepMaxPages so one run cannot
  // monopolize the worker.
  try {
    await drainPages(
      (limit) => deps.repo.findOrphans(cutoff, limit),
      async (orphans) => {
        // Counted per page (not from drainPages' total) so a find failure on a LATER page still reports
        // the rows this run did handle.
        scanned += orphans.length
        await sweepPage(orphans, deps, {
          onDeleted: () => deleted++,
          onError: (err, id) => {
            errors++
            report(err, { job: "orphan.sweep", phase: "delete", mediaId: id })
            log("orphan.sweep: row failed", { mediaId: id, err: String(err) })
          },
          onLeak: (keys, id) => {
            leaked += keys.length
            errors++
            report(
              new Error(
                `orphan.sweep leaked ${keys.length} R2 object(s) (row already deleted, tombstoned for retry)`,
              ),
              { job: "orphan.sweep", phase: "object-delete", mediaId: id, keys },
            )
          },
        })
      },
      { pageSize: deps.limits.orphanSweepBatch, maxPages: deps.limits.orphanSweepMaxPages },
    )
  } catch (err) {
    // sweepPage never throws, so this is the findOrphans query failing: the sweep is degraded, not the
    // rows. Report and return what was reaped before the failure.
    report(err, { job: "orphan.sweep", phase: "find" })
    log("orphan.sweep: find failed", { err: String(err) })
    errors++
  }

  log("orphan.sweep: done", {
    scanned,
    deleted,
    errors,
    leaked,
    retried: retry.retried,
    reclaimed: retry.reclaimed,
    cutoff: cutoff.toISOString(),
  })
  return { scanned, deleted, errors, leaked, retried: retry.retried, reclaimed: retry.reclaimed }
}

/**
 * Re-attempt the R2 deletes recorded in media_reap_tombstones by earlier runs (0057).
 *
 * The three tombstone methods are OPTIONAL on MediaWorkerRepo, so a repo without them (the offline fake,
 * an older impl) degrades to the previous behavior: the leak is reported and forgotten. Never throws.
 */
async function retryTombstonedLeaks(
  deps: OrphanSweepDeps,
  log: JobLogFn,
  report: JobReportFn,
): Promise<{ retried: number; reclaimed: number; errors: number }> {
  const { repo } = deps
  const clear = repo.clearLeakedObject?.bind(repo)
  if (!repo.listLeakedObjects || !clear) return { retried: 0, reclaimed: 0, errors: 0 }

  let rows: LeakedObjectRow[]
  try {
    rows = await repo.listLeakedObjects(LEAK_RETRY_LIMIT, LEAK_RETRY_MAX_ATTEMPTS)
  } catch (err) {
    report(err, { job: "orphan.sweep", phase: "leak-list" })
    log("orphan.sweep: tombstone list failed", { err: String(err) })
    return { retried: 0, reclaimed: 0, errors: 1 }
  }
  if (rows.length === 0) return { retried: 0, reclaimed: 0, errors: 0 }

  let retried = 0
  let reclaimed = 0
  let errors = 0
  await mapWithLimit(rows, ORPHAN_CONCURRENCY, async (row) => {
    retried++
    try {
      await deps.storage.delete(row.r2Key)
      await clear(row.r2Key)
      reclaimed++
    } catch (err) {
      errors++
      const attempts = row.attempts + 1
      // Bump the attempt count so a key that can never be deleted retires from the retry range instead of
      // being re-attempted every hour forever. Recording the bump is itself best-effort: if THIS write
      // fails the tombstone simply keeps its old count and the next run tries again.
      await repo
        .recordLeakedObjects?.({ mediaId: row.mediaId, keys: [row.r2Key], error: String(err) })
        .catch((bumpErr: unknown) =>
          log("orphan.sweep: tombstone bump failed", { key: row.r2Key, err: String(bumpErr) }),
        )
      log("orphan.sweep: tombstoned object delete failed again", {
        key: row.r2Key,
        attempts,
        err: String(err),
      })
      if (attempts >= LEAK_RETRY_MAX_ATTEMPTS) {
        // Terminal: no further sweep will touch this key. This is the one leak an operator must clean up
        // by hand, so it is reported as an error rather than left in a counter.
        report(new Error(`orphan.sweep gave up on a leaked R2 object after ${attempts} attempts`), {
          job: "orphan.sweep",
          phase: "leak-retry",
          key: row.r2Key,
          mediaId: row.mediaId,
        })
      }
    }
  })
  return { retried, reclaimed, errors }
}

interface SweepPageHooks {
  onDeleted: () => void
  onError: (err: unknown, id: string) => void
  /** The row was reaped but these keys survived in R2 (see deleteObjects). */
  onLeak: (keys: string[], id: string) => void
}

/** Reap one page of orphans. Never throws: per-row failures are reported through `hooks.onError`. */
async function sweepPage(
  orphans: OrphanRow[],
  deps: OrphanSweepDeps,
  hooks: SweepPageHooks,
): Promise<void> {
  const { log } = resolveJobObs(deps)
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
      const leaked = stillShared ? [] : await deleteObjects(o, deps, log)
      // The ROW is gone either way, so the reap counts as done; the leak is reported separately.
      hooks.onDeleted()
      if (leaked.length > 0) {
        // TOMBSTONE FIRST, then count/report: this is the only moment these keys are still known, so the
        // write is what makes the leak recoverable at all (a later run retries from the row). Best-effort —
        // if the tombstone write itself fails there is nothing further to fall back to, and the leak is
        // still surfaced by onLeak exactly as it was before 0057.
        await deps.repo
          .recordLeakedObjects?.({ mediaId: o.id, keys: leaked, error: "storage delete failed" })
          .catch((err: unknown) =>
            log("orphan.sweep: tombstone write failed (leak is now unrecoverable)", {
              mediaId: o.id,
              keys: leaked,
              err: String(err),
            }),
          )
        hooks.onLeak(leaked, o.id)
      }
    } catch (err) {
      hooks.onError(err, o.id)
    }
  })
}

/**
 * Delete an orphan's physical objects. Returns the keys that survived a failed delete.
 *
 * DURABILITY TRADE OF THE ROW-FIRST ORDER: the TOCTOU fix above deletes the DB row before the objects, so
 * once the row is gone NO future sweep can REDISCOVER these keys from media_assets — a storage delete that
 * fails here would leak the objects in R2 permanently (the old order retried them on the next sweep, at the
 * cost of the race). That is what media_reap_tombstones (drizzle/0057) is for: the caller records the
 * surviving keys before it forgets them, and retryTombstonedLeaks re-attempts them on later runs up to
 * LEAK_RETRY_MAX_ATTEMPTS. A repo without the tombstone methods degrades to the old behavior — the leak is
 * reported per key and forgotten.
 *
 * Never throws: the row is already gone, so a leaked object must not fail the row's reap or abort the page.
 */
async function deleteObjects(o: OrphanRow, deps: OrphanSweepDeps, log: JobLogFn): Promise<string[]> {
  // The derived keys for one orphan are independent, so fire their R2 DELETEs in parallel.
  const outcomes = await Promise.all(
    derivedKeys(o).map(async (key) => {
      try {
        await deps.storage.delete(key)
        return null
      } catch (err) {
        log("orphan.sweep: object delete failed (LEAKED in R2, row already gone)", {
          mediaId: o.id,
          key,
          err: String(err),
        })
        return key
      }
    }),
  )
  return outcomes.filter((key): key is string => key !== null)
}
