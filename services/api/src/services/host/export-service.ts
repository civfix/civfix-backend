import { AppError } from "@civfix/shared"
import type { HostExportDTO, HostExportFilters, HostExportKind } from "@civfix/shared"
import type { Storage } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import { csvProvenanceRow, csvRow } from "./export-csv.js"
import {
  hostExportBuilder,
  type HostExportBuilder,
  type HostExportContext,
} from "./export-builders.js"
import type { HostExportRecord, HostExportRepository } from "./export-repository.js"
import type { WriteAuditInput } from "../admin/audit.js"
import { MS_PER_HOUR, MS_PER_SECOND } from "../../lib/time.js"

const EXPORT_DOWNLOAD_URL_TTL_SEC = 300
const EXPORT_LIST_LIMIT = 50
const EXPORT_YIELD_EVERY_ROWS = 1000
export const EXPORT_RUN_STALE_MS = 10 * 60 * 1000
export const EXPORT_ABANDON_AFTER_MS = 60 * 60 * 1000
const EXPORT_CONTENT_TYPE = "text/csv; charset=utf-8"
const FALLBACK_EXPORT_FILENAME = "civfix-export.csv"
const ERROR_BUILD_FAILED = "build_failed"
const ERROR_FORBIDDEN = "forbidden"
const ERROR_NOT_STARTED = "not_started"
export const EXPORT_NOT_FOUND = "Export not found"

export interface HostExportConfig {
  maxRows: number
  maxBytes: number
  ttlHours: number
}

export const DEFAULT_EXPORT_MAX_BYTES = 16 * 1024 * 1024

interface PresignStorage {
  put: Storage["put"]
  presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string>
  delete(key: string): Promise<void>
}

interface RenderedCsv {
  parts: Buffer[]
  bytes: number
  rowCount: number
  truncated: boolean
}

export interface HostExportServiceDeps {
  repo: HostExportRepository
  storage: PresignStorage
  config: HostExportConfig
  authorize?: (record: HostExportRecord) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
  now?: () => Date
}

export function toHostExportDTO(record: HostExportRecord): HostExportDTO {
  return {
    id: record.id,
    cleanupId: record.cleanupId,
    organizationId: record.organizationId,
    kind: record.kind,
    status: record.status,
    rowCount: record.rowCount,
    byteSize: record.byteSize,
    truncated: record.truncated,
    errorCode: record.errorCode,
    requestedAt: record.requestedAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
  }
}

export interface HostExportService {
  request(args: {
    cleanupId: string | null
    organizationId: string | null
    requestedBy: string
    kind: HostExportKind
    filters: HostExportFilters | undefined
    audit?: (exportId: string) => WriteAuditInput
  }): Promise<HostExportDTO>
  listForEvent(cleanupId: string): Promise<HostExportDTO[]>
  listForOrganization(organizationId: string): Promise<HostExportDTO[]>
  get(exportId: string): Promise<HostExportRecord>
  run(exportId: string): Promise<{ status: "ready" | "failed" | "skipped" }>
  downloadUrl(
    record: HostExportRecord,
  ): Promise<{ url: string; expiresAt: string; filename: string }>
  reap(limit: number): Promise<{ reaped: number }>
}

export function makeHostExportService(deps: HostExportServiceDeps): HostExportService {
  const now = deps.now ?? (() => new Date())

  /**
   * Each run writes its own object: two runs of one export in one month would otherwise share a key,
   * and a superseded run discarding "its" object would delete the winner's. The export id stays the
   * last segment because the download filename is read from it.
   */
  function storageKey(claimed: HostExportRecord, at: Date): string {
    const year = at.getUTCFullYear()
    const month = String(at.getUTCMonth() + 1).padStart(2, "0")
    const run = claimed.runToken === null ? "" : `${claimed.runToken}/`
    return `exports/host/${year}/${month}/${run}${claimed.id}.csv`
  }

  /** The failed row keeps its key until this succeeds, so the reaper can finish a partial cleanup. */
  async function discardFailedObject(claimed: HostExportRecord, key: string): Promise<void> {
    try {
      await deps.storage.delete(key)
      await deps.repo.releaseObject(
        { id: claimed.id, status: "failed", runToken: claimed.runToken },
        ERROR_BUILD_FAILED,
      )
    } catch (err) {
      deps.logger?.warn(
        { err, exportId: claimed.id },
        "host export: failed run could not clean up its object; the reaper will retry",
      )
    }
  }

  async function claimIsAuthorized(claimed: HostExportRecord): Promise<boolean> {
    if (deps.authorize === undefined) return true
    try {
      await deps.authorize(claimed)
      return true
    } catch (err) {
      deps.logger?.warn(
        { err, exportId: claimed.id },
        "host export refused: the requester no longer holds the capability",
      )
      await deps.repo.markFailed(claimed.id, ERROR_FORBIDDEN, claimed.runToken)
      return false
    }
  }

  async function renderCsv(
    builder: HostExportBuilder,
    ctx: HostExportContext,
  ): Promise<RenderedCsv> {
    const provenance = await builder.provenance(ctx)
    const header = await builder.header(ctx)
    const parts: Buffer[] = []
    let bytes = 0
    const append = (text: string): void => {
      const buf = Buffer.from(text, "utf8")
      parts.push(buf)
      bytes += buf.byteLength
    }
    for (const line of provenance) append(csvProvenanceRow(line))
    append(csvRow(header))

    let rowCount = 0
    let truncated = false
    for await (const row of builder.rows(ctx)) {
      if (rowCount >= deps.config.maxRows || bytes >= deps.config.maxBytes) {
        truncated = true
        break
      }
      append(csvRow(row))
      rowCount += 1
      if (rowCount % EXPORT_YIELD_EVERY_ROWS === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    if (truncated) {
      append(
        csvProvenanceRow(
          `truncated: this file stops at ${rowCount} rows (${deps.config.maxRows} row / ${deps.config.maxBytes} byte cap)`,
        ),
      )
    }
    return { parts, bytes, rowCount, truncated }
  }

  async function discardSupersededObject(claimed: HostExportRecord, key: string): Promise<void> {
    await deps.storage.delete(key).catch((err: unknown) => {
      deps.logger?.warn(
        { err, exportId: claimed.id, key },
        "host export: losing run could not delete its own object",
      )
    })
    deps.logger?.warn(
      { evt: "host.export.superseded", exportId: claimed.id },
      "host export run superseded by a newer claim; its object was discarded",
    )
  }

  async function reapExpired(limit: number): Promise<number> {
    const expired = await deps.repo.listExpired(now(), limit)
    let reaped = 0
    for (const record of expired) {
      if (record.r2Key !== null) {
        try {
          await deps.storage.delete(record.r2Key)
        } catch (err) {
          deps.logger?.warn(
            { err, exportId: record.id },
            "host export reap: object delete failed; row left ready for the next pass",
          )
          continue
        }
      }
      await deps.repo.markExpired(record.id)
      reaped += 1
    }
    return reaped
  }

  async function reapOrphaned(limit: number): Promise<number> {
    let reaped = 0
    const orphaned = await deps.repo.listOrphaned({
      staleBefore: new Date(now().getTime() - EXPORT_ABANDON_AFTER_MS),
      limit,
    })
    for (const record of orphaned) {
      const errorCode = record.status === "queued" ? ERROR_NOT_STARTED : ERROR_BUILD_FAILED
      // Fence first: failing the row under its run token makes a still-live run's markReady miss, so
      // no ready row can end up naming the object deleted below. The key stays on the failed row
      // until the delete succeeds.
      if (
        record.status !== "failed" &&
        !(await deps.repo.markFailed(record.id, errorCode, record.runToken))
      ) {
        continue
      }
      if (record.r2Key === null) {
        reaped += 1
        continue
      }
      try {
        await deps.storage.delete(record.r2Key)
      } catch (err) {
        deps.logger?.warn(
          { err, exportId: record.id },
          "host export reap: orphaned object delete failed; row kept for the next pass",
        )
        continue
      }
      const released = await deps.repo.releaseObject(
        { id: record.id, status: "failed", runToken: record.runToken },
        errorCode,
      )
      if (released) reaped += 1
    }
    return reaped
  }

  return {
    async request(args) {
      const record = await deps.repo.create(
        {
          cleanupId: args.cleanupId,
          organizationId: args.organizationId,
          requestedBy: args.requestedBy,
          kind: args.kind,
          filters: args.filters ?? {},
        },
        args.audit,
      )
      return toHostExportDTO(record)
    },

    async listForEvent(cleanupId) {
      const rows = await deps.repo.listForEvent(cleanupId, EXPORT_LIST_LIMIT)
      return rows.map(toHostExportDTO)
    },

    async listForOrganization(organizationId) {
      const rows = await deps.repo.listForOrganization(organizationId, EXPORT_LIST_LIMIT)
      return rows.map(toHostExportDTO)
    },

    async get(exportId) {
      const record = await deps.repo.findById(exportId)
      if (record === null) throw AppError.notFound(EXPORT_NOT_FOUND)
      return record
    },

    async run(exportId) {
      const at = now()
      const claimed = await deps.repo.claimForRun(
        exportId,
        new Date(at.getTime() - EXPORT_RUN_STALE_MS),
      )
      if (claimed === null) return { status: "skipped" }
      if (!(await claimIsAuthorized(claimed))) return { status: "failed" }
      let key: string | null = null
      const ctx: HostExportContext = {
        exportId: claimed.id,
        cleanupId: claimed.cleanupId,
        organizationId: claimed.organizationId,
        requestedBy: claimed.requestedBy,
        filters: claimed.filters,
        now: at,
      }
      try {
        const builder = hostExportBuilder(claimed.kind)
        const { parts, bytes, rowCount, truncated } = await renderCsv(builder, ctx)

        // A re-claimed row still names the crashed run's object. It is deleted before this run's key
        // replaces it; if the delete fails the row fails holding that key, so the reaper finishes it.
        if (claimed.r2Key !== null) await deps.storage.delete(claimed.r2Key)
        key = storageKey(claimed, at)
        const owned = await deps.repo.recordObjectKey(claimed.id, {
          r2Key: key,
          runToken: claimed.runToken,
          replaces: claimed.r2Key,
        })
        if (!owned) {
          deps.logger?.warn(
            { evt: "host.export.superseded", exportId: claimed.id },
            "host export run superseded by a newer claim before it uploaded",
          )
          return { status: "skipped" }
        }
        await deps.storage.put(key, Buffer.concat(parts), {
          contentType: EXPORT_CONTENT_TYPE,
          contentDisposition: `attachment; filename="${builder.filename(ctx)}"`,
        })
        const expiresAt = new Date(at.getTime() + deps.config.ttlHours * MS_PER_HOUR)
        const ready = await deps.repo.markReady(claimed.id, {
          r2Key: key,
          rowCount,
          byteSize: bytes,
          truncated,
          expiresAt,
          runToken: claimed.runToken,
        })
        if (ready === null) {
          await discardSupersededObject(claimed, key)
          return { status: "skipped" }
        }
        deps.logger?.info(
          { evt: "host.export.ready", exportId: claimed.id, rowCount, bytes, truncated },
          "host export ready",
        )
        return { status: "ready" }
      } catch (err) {
        deps.logger?.error({ err, exportId: claimed.id }, "host export failed")
        await deps.repo.markFailed(claimed.id, ERROR_BUILD_FAILED, claimed.runToken)
        if (key !== null) await discardFailedObject(claimed, key)
        return { status: "failed" }
      }
    },

    async downloadUrl(record) {
      if (record.status !== "ready" || record.r2Key === null) {
        throw AppError.conflict("That export is not ready to download.")
      }
      if (record.expiresAt !== null && record.expiresAt.getTime() <= now().getTime()) {
        throw AppError.conflict("That export has expired.")
      }
      const url = await deps.storage.presignGet(record.r2Key, EXPORT_DOWNLOAD_URL_TTL_SEC, {
        forceSigned: true,
      })
      const filename = record.r2Key.split("/").pop() ?? FALLBACK_EXPORT_FILENAME
      return {
        url,
        expiresAt: new Date(
          now().getTime() + EXPORT_DOWNLOAD_URL_TTL_SEC * MS_PER_SECOND,
        ).toISOString(),
        filename,
      }
    },

    async reap(limit) {
      const reaped = (await reapExpired(limit)) + (await reapOrphaned(limit))
      return { reaped }
    },
  }
}
