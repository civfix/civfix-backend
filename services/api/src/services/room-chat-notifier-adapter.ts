import type { ChatMessageDTO } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import {
  makeRoomFanoutNotifier,
  ROOM_FANOUT_SPEC,
  type RoomFanoutKind,
  type RoomFanoutNotifierDeps,
} from "./chat-room-fanout-notifier.js"

export type RoomChatNotifierDeps<K extends RoomFanoutKind> = Pick<
  RoomFanoutNotifierDeps,
  | "notificationService"
  | "isMuted"
  | "mutedUserIdsFor"
  | "isBlockedEitherWay"
  | "blockedIdsFor"
  | "coalesceWindowMs"
  | "now"
  | "claimWindow"
  | "dispatchToJob"
> & {
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: K, id: string) => string
  logger?: Pick<FastifyBaseLogger, "warn" | "error"> | undefined
}

export function makeRoomChatNotifier<K extends RoomFanoutKind>(
  kind: K,
  deps: RoomChatNotifierDeps<K>,
  listMemberIds: RoomFanoutNotifierDeps["listMemberIds"],
): (roomId: string, message: ChatMessageDTO) => Promise<void> {
  return makeRoomFanoutNotifier(ROOM_FANOUT_SPEC[kind], {
    notificationService: deps.notificationService,
    listMemberIds,
    isMuted: deps.isMuted,
    ...(deps.mutedUserIdsFor ? { mutedUserIdsFor: deps.mutedUserIdsFor } : {}),
    presence: deps.presence,
    roomKey: (roomId) => deps.roomKeyFor(kind, roomId),
    isBlockedEitherWay: deps.isBlockedEitherWay,
    ...(deps.blockedIdsFor ? { blockedIdsFor: deps.blockedIdsFor } : {}),
    ...(deps.coalesceWindowMs !== undefined ? { coalesceWindowMs: deps.coalesceWindowMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.claimWindow !== undefined ? { claimWindow: deps.claimWindow } : {}),
    ...(deps.dispatchToJob !== undefined ? { dispatchToJob: deps.dispatchToJob } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  })
}
