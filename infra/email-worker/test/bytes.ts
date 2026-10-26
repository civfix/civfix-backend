export function bytes(text: string): ArrayBuffer {
  return new Uint8Array(new TextEncoder().encode(text)).buffer
}
