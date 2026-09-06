import { Readable } from "node:stream"
import { createInflateRaw } from "node:zlib"

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_LENGTH = 22
const MAX_COMMENT_LENGTH = 0xffff
const ZIP64_MARKER_32 = 0xffffffff
const ZIP64_MARKER_16 = 0xffff
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

export const ARCHIVE_CHUNK_BYTES = 1 << 16

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ZipFormatError"
  }
}

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  dataOffset: number
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function findEndOfCentralDirectory(view: DataView): number {
  const floor = Math.max(0, view.byteLength - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH)
  for (let offset = view.byteLength - EOCD_MIN_LENGTH; offset >= floor; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  throw new ZipFormatError("not a ZIP archive: end-of-central-directory record not found")
}

export function listZipEntries(archive: Uint8Array): ZipEntry[] {
  if (archive.byteLength < EOCD_MIN_LENGTH) throw new ZipFormatError("archive too small")
  const view = viewOf(archive)
  const eocd = findEndOfCentralDirectory(view)
  const entryCount = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (
    entryCount === ZIP64_MARKER_16 ||
    directorySize === ZIP64_MARKER_32 ||
    directoryOffset === ZIP64_MARKER_32
  ) {
    throw new ZipFormatError("zip64 archives are not supported")
  }
  if (directoryOffset + directorySize > archive.byteLength) {
    throw new ZipFormatError("central directory lies outside the archive")
  }

  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > archive.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError("malformed central directory")
    }
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    if (
      compressedSize === ZIP64_MARKER_32 ||
      uncompressedSize === ZIP64_MARKER_32 ||
      localOffset === ZIP64_MARKER_32
    ) {
      throw new ZipFormatError("zip64 entries are not supported")
    }
    const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength))
    if (localOffset + 30 > archive.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new ZipFormatError(`malformed local header for ${name}`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > archive.byteLength) {
      throw new ZipFormatError(`entry data for ${name} lies outside the archive`)
    }
    entries.push({ name, method, compressedSize, uncompressedSize, dataOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const LIST_EXTENSIONS = [".txt", ".csv", ".dat"]

export function selectListEntry(entries: readonly ZipEntry[]): ZipEntry {
  const files = entries.filter((entry) => !entry.name.endsWith("/") && entry.uncompressedSize > 0)
  const preferred = files.filter((entry) =>
    LIST_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension)),
  )
  const chosen = preferred[0] ?? files[0]
  if (chosen === undefined) throw new ZipFormatError("archive holds no data file")
  if (chosen.method !== METHOD_STORED && chosen.method !== METHOD_DEFLATE) {
    throw new ZipFormatError(`unsupported compression method ${chosen.method} for ${chosen.name}`)
  }
  return chosen
}

export async function* byteChunks(
  bytes: Uint8Array,
  size: number = ARCHIVE_CHUNK_BYTES,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength))
  }
}

async function* bufferChunks(bytes: Uint8Array): AsyncIterable<Buffer> {
  for await (const chunk of byteChunks(bytes)) {
    yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
}

export async function* zipEntryChunks(
  archive: Uint8Array,
  entry: ZipEntry,
): AsyncIterable<Uint8Array> {
  const compressed = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  if (entry.method === METHOD_STORED) {
    yield* byteChunks(compressed)
    return
  }
  const inflater = createInflateRaw()
  const source = Readable.from(bufferChunks(compressed))
  source.on("error", (error) => inflater.destroy(error))
  for await (const chunk of source.pipe(inflater)) {
    yield chunk as Buffer
  }
}

export function zipDataChunks(archive: Uint8Array): AsyncIterable<Uint8Array> {
  return zipEntryChunks(archive, selectListEntry(listZipEntries(archive)))
}
