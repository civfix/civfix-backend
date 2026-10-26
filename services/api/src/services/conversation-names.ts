import { REPORT_CATEGORY_LABELS } from "@civfix/contract"
import type { ReportCategory } from "@civfix/contract"
import type { FastifyBaseLogger } from "fastify"

export type NamedRoomKind = "cleanup" | "report" | "group"

/** Each lookup answers null for a room that no longer exists. */
export interface ConversationNameLookups {
  groupName(groupId: string): Promise<string | null>
  reportCategory(reportId: string): Promise<ReportCategory | null>
  eventTitle(cleanupId: string): Promise<string | null>
}

async function lookUp(
  lookups: ConversationNameLookups,
  kind: NamedRoomKind,
  roomId: string,
): Promise<string | null> {
  switch (kind) {
    case "group":
      return lookups.groupName(roomId)
    case "report": {
      const category = await lookups.reportCategory(roomId)
      return category === null ? null : REPORT_CATEGORY_LABELS[category]
    }
    case "cleanup":
      return lookups.eventTitle(roomId)
  }
}

/**
 * The name a notification email gives the conversation (D10). It only labels the email, so a failed
 * lookup leaves it out rather than costing the recipient their bell.
 */
export async function conversationNameOf(
  lookups: ConversationNameLookups | undefined,
  kind: NamedRoomKind,
  roomId: string,
  logger?: Pick<FastifyBaseLogger, "warn">,
): Promise<string | undefined> {
  if (lookups === undefined) return undefined
  try {
    const name = await lookUp(lookups, kind, roomId)
    return name !== null && name.trim() !== "" ? name : undefined
  } catch (err) {
    logger?.warn({ err, kind }, "conversation name lookup failed; the bell goes out without it")
    return undefined
  }
}
