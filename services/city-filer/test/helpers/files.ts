import { stat } from "node:fs/promises"

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12NgZGIGAAAOAAcGTPsnAAAAAElFTkSuQmCC",
  "base64",
)

export const MB = 1024 * 1024

/** A PNG of exactly `size` bytes: a one-pixel image with trailing padding. */
export function pngOfSize(size: number): Buffer {
  return Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(Math.max(0, size - ONE_PIXEL_PNG.length))])
}

export function jpegOfSize(size: number): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))])
}

export async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
