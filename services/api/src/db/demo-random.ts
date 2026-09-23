/**
 * The demo CLIs' shared PRNG. Guard-free (no runIfMain) so both can import it: tsup (splitting: false)
 * inlines imports into each bundled entry, and an imported runIfMain guard would fire inside the
 * importing bundle.
 *
 * Seeded so a rehearsal, the committed run and a re-run after purge generate the same rows. Every helper
 * draws from the one stream in call order, so reordering calls changes the generated data.
 */

export const DEMO_PRNG_SEED = 20260902

const UINT32_RANGE = 4294967296

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE
  }
}

let source = mulberry32(DEMO_PRNG_SEED)

export function seedDemoRandom(seed: number): void {
  source = mulberry32(seed)
}

export function rand(): number {
  return source()
}

export function rint(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1))
}

export function chance(p: number): boolean {
  return rand() < p
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]!
}

export function pickWeighted<T>(items: readonly (readonly [T, number])[]): T {
  let total = 0
  for (const [, w] of items) total += w
  let roll = rand() * total
  for (const [v, w] of items) {
    roll -= w
    if (roll <= 0) return v
  }
  return items[items.length - 1]![0]
}

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

export function sampleWeighted<T>(
  items: readonly T[],
  weightOf: (t: T) => number,
  n: number,
  exclude: Set<T>,
): T[] {
  const out: T[] = []
  const taken = new Set(exclude)
  const pool = items.filter((i) => !taken.has(i))
  for (let k = 0; k < n && pool.length > 0; k++) {
    let total = 0
    for (const i of pool) total += weightOf(i)
    if (total <= 0) break
    let roll = rand() * total
    let idx = pool.length - 1
    for (let j = 0; j < pool.length; j++) {
      roll -= weightOf(pool[j]!)
      if (roll <= 0) {
        idx = j
        break
      }
    }
    out.push(pool[idx]!)
    pool.splice(idx, 1)
  }
  return out
}
