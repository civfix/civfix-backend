import type { ReportCategory } from "@civfix/contract"
import type { FastifyBaseLogger } from "fastify"

export type NamedRoomKind = "cleanup" | "report" | "group"

/** Each lookup answers null for a room that no longer exists. */
export interface ConversationNameLookups {
  groupName(groupId: string): Promise<string | null>
  reportCategory(reportId: string): Promise<ReportCategory | null>
  eventTitle(cleanupId: string): Promise<string | null>
}

export function conversationNameOf(
  _lookups: ConversationNameLookups | undefined,
  _kind: NamedRoomKind,
  _roomId: string,
  _logger?: Pick<FastifyBaseLogger, "warn">,
): Promise<string | undefined> {
  throw new Error("not implemented")
}
