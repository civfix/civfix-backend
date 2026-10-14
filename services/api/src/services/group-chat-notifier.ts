import type { ChatMessageDTO } from "@civfix/shared"
import { makeRoomChatNotifier, type RoomChatNotifierDeps } from "./room-chat-notifier-adapter.js"

export interface GroupChatNotifierDeps extends RoomChatNotifierDeps<"group"> {
  groupRepo: { listMemberIds(groupId: string, limit: number): Promise<string[]> }
}

export function makeGroupChatNotifier(
  deps: GroupChatNotifierDeps,
): (groupId: string, message: ChatMessageDTO) => Promise<void> {
  return makeRoomChatNotifier("group", deps, (groupId, limit) =>
    deps.groupRepo.listMemberIds(groupId, limit),
  )
}
