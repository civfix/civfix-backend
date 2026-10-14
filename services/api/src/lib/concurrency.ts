// Order-preserving, used instead of `Promise.all(arr.map(fn))` on fan-outs so a large page can't fire
// hundreds of concurrent R2/DB ops.
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const cap = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const workers = Array.from({ length: cap }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T, i)
    }
  })
  await Promise.all(workers)
  return results
}
