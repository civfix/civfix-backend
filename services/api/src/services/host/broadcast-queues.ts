export interface BroadcastPlanJob {
  broadcastId: string
}

export interface BroadcastChunkJob {
  broadcastId: string
  chunkNo: number
  authRetry: number
}

export interface HostExportJob {
  exportId: string
}

export function parseBroadcastPlanJob(data: unknown): BroadcastPlanJob | null {
  const id = readId(data, "broadcastId")
  return id === null ? null : { broadcastId: id }
}

export function parseBroadcastChunkJob(data: unknown): BroadcastChunkJob | null {
  const id = readId(data, "broadcastId")
  if (id === null) return null
  if (typeof data !== "object" || data === null) return null
  const raw = (data as { chunkNo?: unknown }).chunkNo
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null
  const retry = (data as { authRetry?: unknown }).authRetry
  const authRetry = typeof retry === "number" && Number.isInteger(retry) && retry > 0 ? retry : 0
  return { broadcastId: id, chunkNo: raw, authRetry }
}

export function parseHostExportJob(data: unknown): HostExportJob | null {
  const id = readId(data, "exportId")
  return id === null ? null : { exportId: id }
}

function readId(data: unknown, key: string): string | null {
  if (typeof data !== "object" || data === null) return null
  const value = (data as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : null
}
