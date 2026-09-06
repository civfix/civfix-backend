import type { EligibilitySourceValue } from "../../db/schema/types-payments.js"
import {
  MIN_DECODE_RATIO,
  normalizeOrgName,
  splitLine,
  type DecodedRow,
  type EligibilitySourceSpec,
  type HeaderIndex,
} from "./eligibility-sources.js"
import { byteChunks, zipDataChunks } from "./eligibility-zip.js"

export const YIELD_EVERY_LINES = 5000

export const MAX_INFLATED_BYTES = 1024 * 1024 * 1024

export const MAX_LINE_LENGTH = 64 * 1024

export const MAX_REVISION_SHRINK = 0.5

export type ImportAbortReason =
  | "unsupported_layout"
  | "too_few_rows"
  | "low_decode_ratio"
  | "revision_drift"
  | "unreadable_archive"

export class EligibilityImportAbort extends Error {
  readonly source: EligibilitySourceValue
  readonly reason: ImportAbortReason

  constructor(source: EligibilitySourceValue, reason: ImportAbortReason, detail: string) {
    super(`eligibility import ${source} aborted (${reason}): ${detail}`)
    this.name = "EligibilityImportAbort"
    this.source = source
    this.reason = reason
  }
}

export interface ScreeningTarget {
  organizationId: string
  ein: string
  irsLegalName: string | null
  orgName: string
}

export interface TargetIndex {
  byEin: Map<string, ScreeningTarget[]>
  byName: Map<string, ScreeningTarget[]>
  size: number
}

export function indexTargets(targets: readonly ScreeningTarget[]): TargetIndex {
  const byEin = new Map<string, ScreeningTarget[]>()
  const byName = new Map<string, ScreeningTarget[]>()
  const add = (map: Map<string, ScreeningTarget[]>, key: string, target: ScreeningTarget) => {
    if (key.length === 0) return
    const existing = map.get(key)
    if (existing === undefined) map.set(key, [target])
    else if (!existing.includes(target)) existing.push(target)
  }
  for (const target of targets) {
    add(byEin, target.ein.replace(/\D/g, ""), target)
    add(byName, normalizeOrgName(target.irsLegalName), target)
    add(byName, normalizeOrgName(target.orgName), target)
  }
  return { byEin, byName, size: targets.length }
}

export interface RevisionPart {
  key: string
  sha256: string
  bytes: Uint8Array
}

export interface ScanHit {
  row: DecodedRow
  partKey: string
  partSha256: string
}

export interface ScanOutcome {
  rowCount: number
  decodedCount: number
  hits: Map<string, ScanHit[]>
}

export async function* linesOf(chunks: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let pending = ""
  let total = 0
  for await (const chunk of chunks) {
    total += chunk.byteLength
    if (total > MAX_INFLATED_BYTES) throw new Error("decoded list exceeded the inflated-byte ceiling")
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf("\n")
    while (newline >= 0) {
      yield pending.slice(0, newline).replace(/\r$/, "")
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }
    if (pending.length > MAX_LINE_LENGTH) throw new Error("decoded list carries a line beyond the length ceiling")
  }
  pending += decoder.decode()
  if (pending.length > 0) yield pending.replace(/\r$/, "")
}

function partChunks(spec: EligibilitySourceSpec, part: RevisionPart): AsyncIterable<Uint8Array> {
  return spec.container === "zip" ? zipDataChunks(part.bytes) : byteChunks(part.bytes)
}

function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function stripBom(line: string): string {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line
}

export async function scanRevision(
  spec: EligibilitySourceSpec,
  parts: readonly RevisionPart[],
  targets: TargetIndex,
): Promise<ScanOutcome> {
  const hits = new Map<string, ScanHit[]>()
  let rowCount = 0
  let decodedCount = 0

  const record = (matched: readonly ScreeningTarget[] | undefined, hit: ScanHit) => {
    if (matched === undefined) return
    for (const target of matched) {
      const existing = hits.get(target.organizationId)
      if (existing === undefined) hits.set(target.organizationId, [hit])
      else existing.push(hit)
    }
  }

  for (const part of parts) {
    let header: HeaderIndex | null = null
    let index = 0
    let lines: AsyncIterable<string>
    try {
      lines = linesOf(partChunks(spec, part))
    } catch (error) {
      throw new EligibilityImportAbort(
        spec.source,
        "unreadable_archive",
        error instanceof Error ? error.message : String(error),
      )
    }
    try {
      for await (const raw of lines) {
        const line = index === 0 ? stripBom(raw) : raw
        index++
        if (line.trim().length === 0) continue
        if (spec.hasHeader && index === 1) {
          header = spec.decoder.bindHeader(splitLine(line, spec.delimiter))
          if (header === null) {
            throw new EligibilityImportAbort(
              spec.source,
              "unsupported_layout",
              `header of ${part.key} does not carry the expected columns`,
            )
          }
          continue
        }
        rowCount++
        if (rowCount % YIELD_EVERY_LINES === 0) await yieldToLoop()
        const row = spec.decoder.decode(splitLine(line, spec.delimiter), header)
        if (row === null) continue
        decodedCount++
        const hit: ScanHit = { row, partKey: part.key, partSha256: part.sha256 }
        if (spec.matchOn === "ein") {
          if (row.ein !== null) record(targets.byEin.get(row.ein), hit)
        } else {
          record(targets.byName.get(normalizeOrgName(row.name)), hit)
        }
      }
    } catch (error) {
      if (error instanceof EligibilityImportAbort) throw error
      throw new EligibilityImportAbort(
        spec.source,
        "unreadable_archive",
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return { rowCount, decodedCount, hits }
}

export function assertSanityFloor(
  spec: EligibilitySourceSpec,
  outcome: ScanOutcome,
  priorRowCount: number | null = null,
): void {
  if (outcome.rowCount < spec.minRows) {
    throw new EligibilityImportAbort(
      spec.source,
      "too_few_rows",
      `${outcome.rowCount} rows parsed, floor is ${spec.minRows}`,
    )
  }
  if (outcome.decodedCount < outcome.rowCount * MIN_DECODE_RATIO) {
    throw new EligibilityImportAbort(
      spec.source,
      "low_decode_ratio",
      `${outcome.decodedCount} of ${outcome.rowCount} rows decoded`,
    )
  }
  if (priorRowCount !== null && outcome.rowCount < priorRowCount * (1 - MAX_REVISION_SHRINK)) {
    throw new EligibilityImportAbort(
      spec.source,
      "revision_drift",
      `${outcome.rowCount} rows parsed against ${priorRowCount} in the previous archived revision`,
    )
  }
}
