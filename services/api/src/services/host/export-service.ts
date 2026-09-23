import { AppError } from "@civfix/shared"
import type { HostExportDTO, HostExportFilters, HostExportKind } from "@civfix/shared"
import type { Storage } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import { csvProvenanceRow, csvRow } from "./export-csv.js"
import { hostExportBuilder, type HostExportContext } from "./export-builders.js"
import type { HostExportRecord, HostExportRepository } from "./export-repository.drizzle.js"
import type { WriteAuditInput } from "../admin/audit.js"

export const EXPORT_DOWNLOAD_URL_TTL_SEC = 300
export const EXPORT_LIST_LIMIT = 50
export const EXPORT_YIELD_EVERY_ROWS = 1000
export const EXPORT_RUN_STALE_MS = 10 * 60 * 1000

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

  function storageKey(exportId: string, at: Date): string {
    const year = at.getUTCFullYear()
    const month = String(at.getUTCMonth() + 1).padStart(2, "0")
    return `exports/host/${year}/${month}/${exportId}.csv`
  }

  return {
    async request(args) {
      const record = await deps.repo.create(
        {
          cleanupId: args.cleanupId,
          organizationId: args.organizationId,
          requestedBy: args.requestedBy,
          kind: args.kind,
          filters: (args.filters ?? {}) as Record<string, unknown>,
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
      if (record === null) throw AppError.notFound("Export not found")
      return record
    },

    async run(exportId) {
      const at = now()
      const claimed = await deps.repo.claimForRun(
        exportId,
        new Date(at.getTime() - EXPORT_RUN_STALE_MS),
      )
      if (claimed === null) return { status: "skipped" }
      if (deps.authorize !== undefined) {
        try {
          await deps.authorize(claimed)
        } catch (err) {
          deps.logger?.warn(
            { err, exportId: claimed.id },
            "host export refused: the requester no longer holds the capability",
          )
          await deps.repo.markFailed(claimed.id, "forbidden")
          return { status: "failed" }
        }
      }
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
        const provenance = await builder.provenance(ctx)
        const header = await builder.header(ctx)
        const parts: Buffer[] = []
        let bytes = 0
        for (const line of provenance) {
          const buf = Buffer.from(csvProvenanceRow(line), "utf8")
          parts.push(buf)
          bytes += buf.byteLength
        }
        const headerBuf = Buffer.from(csvRow(header), "utf8")
        parts.push(headerBuf)
        bytes += headerBuf.byteLength

        let rowCount = 0
        let truncated = false
        for await (const row of builder.rows(ctx)) {
          if (rowCount >= deps.config.maxRows || bytes >= deps.config.maxBytes) {
            truncated = true
            break
          }
          const buf = Buffer.from(csvRow(row), "utf8")
          parts.push(buf)
          bytes += buf.byteLength
          rowCount += 1
          if (rowCount % EXPORT_YIELD_EVERY_ROWS === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        }
        if (truncated) {
          const note = Buffer.from(
            csvProvenanceRow(
              `truncated: this file stops at ${rowCount} rows (${deps.config.maxRows} row / ${deps.config.maxBytes} byte cap)`,
            ),
            "utf8",
          )
          parts.push(note)
          bytes += note.byteLength
        }

        const key = storageKey(claimed.id, at)
        await deps.storage.put(key, Buffer.concat(parts), {
          contentType: "text/csv; charset=utf-8",
          contentDisposition: `attachment; filename="${builder.filename(ctx)}"`,
        })
        const expiresAt = new Date(at.getTime() + deps.config.ttlHours * 3_600_000)
        const ready = await deps.repo.markReady(claimed.id, {
          r2Key: key,
          rowCount,
          byteSize: bytes,
          truncated,
          expiresAt,
          runToken: claimed.runToken,
        })
        if (ready === null) {
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
          return { status: "skipped" }
        }
        deps.logger?.info(
          { evt: "host.export.ready", exportId: claimed.id, rowCount, bytes, truncated },
          "host export ready",
        )
        return { status: "ready" }
      } catch (err) {
        deps.logger?.error({ err, exportId: claimed.id }, "host export failed")
        await deps.repo.markFailed(claimed.id, "build_failed")
        return { status: "failed" }
      }
    },

    async downloadUrl(record) {
      if (record.status !== "ready" || record.r2Key === null) {
        throw AppError.conflict("That export is not ready to download.")
      }
      const url = await deps.storage.presignGet(record.r2Key, EXPORT_DOWNLOAD_URL_TTL_SEC, {
        forceSigned: true,
      })
      const filename = record.r2Key.split("/").pop() ?? "civfix-export.csv"
      return {
        url,
        expiresAt: new Date(now().getTime() + EXPORT_DOWNLOAD_URL_TTL_SEC * 1000).toISOString(),
        filename,
      }
    },

    async reap(limit) {
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
      return { reaped }
    },
  }
}
