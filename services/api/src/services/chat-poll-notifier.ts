
import type { FastifyBaseLogger } from "fastify"
import type { ChatMessageDTO } from "@civfix/shared"
import type { Container } from "../di.js"
import type { PollRoomKind } from "./chat-poll-service.js"
import {
  makeRoomFanoutNotifier,
  ROOM_FANOUT_SPEC,
  type RoomFanoutKind,
} from "./chat-room-fanout-notifier.js"
import { makeContainerRoomFanoutDeps } from "./chat-room-notifier-wiring.js"

export type PollRoomNotifier = (
  roomKind: PollRoomKind,
  roomId: string,
  message: ChatMessageDTO,
) => void

const NOOP_POLL_NOTIFIER: PollRoomNotifier = () => {}

export function makeContainerPollNotifier(
  container: Container,
  logger?: FastifyBaseLogger,
): PollRoomNotifier {
  if (container.env.USE_FAKE_CHAT) return NOOP_POLL_NOTIFIER

  const deps = makeContainerRoomFanoutDeps(container, logger)
  const notify = (kind: RoomFanoutKind) =>
    makeRoomFanoutNotifier(ROOM_FANOUT_SPEC[kind], deps[kind])

  const notifyReport = notify("report")
  const notifyGroup = notify("group")

  return (roomKind, roomId, message) => {
    if (roomKind === "report") void notifyReport(roomId, message).catch(() => {})
    else if (roomKind === "group") void notifyGroup(roomId, message).catch(() => {})
  }
}
