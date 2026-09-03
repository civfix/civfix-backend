/**
 * Single source of truth for maintaining `users.last_activity_geom` / `users.last_activity_at`
 * (0102, audit H18).
 *
 * The column pair materialises what `suggestFollows` used to re-derive per candidate with a LATERAL
 * over reports + cleanups: the point of the user's most recent locatable PUBLIC act. Every write path
 * that produces such an act calls `touchUserActivity` inside its own transaction, so the point is
 * committed with the act rather than by a background job that can lag or fail.
 *
 * MONOTONIC BY CONSTRUCTION: the guard `last_activity_at IS NULL OR last_activity_at < $at` means a
 * late-committing or re-run writer can never drag the point backwards, which is also what makes the
 * backfill safe to run against a live database (it only fills rows the live paths have not reached).
 *
 * Callers pass the act's own timestamp, never `now()`, so the value matches the row it came from.
 */

import type { Queryable } from "../client.js"

export async function touchUserActivity(
  tx: Queryable,
  args: { userId: string; lng: number; lat: number; at: Date },
): Promise<void> {
  await tx`
    UPDATE users
    SET last_activity_geom = ST_SetSRID(ST_MakePoint(${args.lng}, ${args.lat}), 4326),
        last_activity_at = ${args.at}
    WHERE id = ${args.userId}
      AND (last_activity_at IS NULL OR last_activity_at < ${args.at})
  `
}
