// The wire schema already coerces and caps; this clamp keeps a repo from ever receiving a 0, negative or
// huge LIMIT.
export function clampPageLimit(limit: number | undefined, fallback: number, max: number): number {
  return limit === undefined || !Number.isFinite(limit)
    ? fallback
    : Math.min(Math.max(1, Math.floor(limit)), max)
}
