import type { HostExportKind } from "@civfix/shared"

export interface HostExportContext {
  exportId: string
  cleanupId: string | null
  organizationId: string | null
  requestedBy: string
  filters: Record<string, unknown>
  now: Date
}

export interface HostExportBuilder {
  header(ctx: HostExportContext): Promise<readonly string[]>
  rows(ctx: HostExportContext): AsyncIterable<readonly string[]>
  provenance(ctx: HostExportContext): Promise<readonly string[]>
  filename(ctx: HostExportContext): string
}

const builders = new Map<HostExportKind, HostExportBuilder>()

export function registerHostExportBuilder(kind: HostExportKind, builder: HostExportBuilder): void {
  if (builders.has(kind)) throw new Error(`host export builder already registered: ${kind}`)
  builders.set(kind, builder)
}

export function hostExportBuilder(kind: HostExportKind): HostExportBuilder {
  const builder = builders.get(kind)
  if (builder === undefined) throw new Error(`no host export builder for kind: ${kind}`)
  return builder
}

export function resetHostExportBuildersForTests(): void {
  builders.clear()
}
