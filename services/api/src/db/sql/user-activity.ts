
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
