export function presentIds(ids: Iterable<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (id == null || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
