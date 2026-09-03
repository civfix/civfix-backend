
import type { ChatMessageDTO } from "@civfix/shared"

export function toTombstoneDTO(dto: ChatMessageDTO, deletedAt: Date): ChatMessageDTO {
  return {
    id: dto.id,
    cleanupId: dto.cleanupId,
    ...(dto.roomKind !== undefined ? { roomKind: dto.roomKind } : {}),
    ...(dto.from !== undefined ? { from: dto.from } : {}),
    kind: dto.kind,
    attachments: [],
    reactions: [],
    mentions: [],
    createdAt: dto.createdAt,
    deletedAt: deletedAt.toISOString(),
    ...(dto.mine !== undefined ? { mine: dto.mine } : {}),
    ...(dto.clientId !== undefined ? { clientId: dto.clientId } : {}),
    ...(dto.replyToId != null ? { replyToId: dto.replyToId, replyTo: dto.replyTo ?? null } : {}),
    ...(dto.forwardedToCity !== undefined
      ? { forwardedToCity: dto.forwardedToCity, cityMention: null }
      : {}),
  }
}

export interface DeletableRow {
  id: string
  deleted_at: Date | null
}

export function liveMessageIds(rows: readonly DeletableRow[]): string[] {
  return rows.filter((r) => r.deleted_at === null).map((r) => r.id)
}
