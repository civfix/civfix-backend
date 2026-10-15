export interface CappedChunks {
  chunks: Uint8Array[]
  total: number
}

/**
 * The cap is enforced while streaming, so a body that lies about (or omits) its content-length is cut off
 * at maxBytes instead of being buffered whole. On overflow `onOverflow` runs (callers abort the fetch) and
 * null is returned; read errors propagate raw. The caller owns the reader and releases its lock.
 */
export async function readCappedChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<CappedChunks | null> {
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        onOverflow()
        return null
      }
      chunks.push(value)
    }
  }
  return { chunks, total }
}

export function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
