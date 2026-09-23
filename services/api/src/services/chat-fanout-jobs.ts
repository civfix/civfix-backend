import type { FastifyBaseLogger } from "fastify"
import type { ChatMessageDTO } from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import type { Container } from "../di.js"
import { makeDrizzleChatRepository } from "./chat-repository.drizzle.js"
import {
  ROOM_FANOUT_SPEC,
  ROOM_FANOUT_THROTTLE_MS,
  runRoomFanout,
  type RoomFanoutKind,
} from "./chat-room-fanout-notifier.js"
import {
  makeContainerRoomFanoutDeps,
  type ContainerRoomFanoutDeps,
  type RoomFanoutLogger,
} from "./chat-room-notifier-wiring.js"

export const CHAT_ROOM_FANOUT_JOB = "chat.room.fanout"

export interface ChatRoomFanoutJob {
  kind: RoomFanoutKind
  roomId: string
  messageId: string
}

export function roomFanoutSingletonKey(
  kind: RoomFanoutKind,
  roomId: string,
  atMs: number,
  windowMs: number,
): string {
  const window = windowMs > 0 ? windowMs : ROOM_FANOUT_THROTTLE_MS
  return `${kind}:${roomId}:${Math.floor(atMs / window)}`
}

export interface RoomFanoutDispatcherOptions {
  windowMs?: number
  now?: () => number
}

export function makeRoomFanoutDispatcher(
  jobs: Pick<Jobs, "enqueue">,
  kind: RoomFanoutKind,
  opts: RoomFanoutDispatcherOptions = {},
): (roomId: string, messageId: string) => Promise<void> {
  const windowMs = opts.windowMs ?? ROOM_FANOUT_THROTTLE_MS
  const now = opts.now ?? (() => Date.now())
  return async (roomId, messageId) => {
    await jobs.enqueue(
      CHAT_ROOM_FANOUT_JOB,
      { kind, roomId, messageId } satisfies ChatRoomFanoutJob,
      { singletonKey: roomFanoutSingletonKey(kind, roomId, now(), windowMs) },
    )
  }
}

export function parseChatRoomFanoutJob(data: unknown): ChatRoomFanoutJob | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  if (d.kind !== "group" && d.kind !== "report") return null
  if (typeof d.roomId !== "string" || d.roomId.length === 0) return null
  if (typeof d.messageId !== "string" || d.messageId.length === 0) return null
  return { kind: d.kind, roomId: d.roomId, messageId: d.messageId }
}

export async function registerChatRoomFanoutJob(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (container.env.USE_FAKE_CHAT) return
  await container.jobs.work(CHAT_ROOM_FANOUT_JOB, async (job) => {
    const data = parseChatRoomFanoutJob(job.data)
    if (data === null) {
      logger?.warn({ jobId: job.id }, "chat.room.fanout: malformed job data (skipped)")
      return
    }
    await runChatRoomFanoutJob(container, data, logger)
  })
}

export interface ChatRoomFanoutRunDeps {
  loadMessage: (data: ChatRoomFanoutJob) => Promise<ChatMessageDTO | null>
  fanoutDeps: ContainerRoomFanoutDeps
}

export async function runChatRoomFanout(
  deps: ChatRoomFanoutRunDeps,
  data: ChatRoomFanoutJob,
): Promise<void> {
  const message = await deps.loadMessage(data)
  if (message === null) return
  if (message.deletedAt !== undefined && message.deletedAt !== null) return
  await runRoomFanout(ROOM_FANOUT_SPEC[data.kind], deps.fanoutDeps[data.kind], data.roomId, message)
}

export async function runChatRoomFanoutJob(
  container: Container,
  data: ChatRoomFanoutJob,
  logger?: RoomFanoutLogger,
): Promise<void> {
  const chatRepo = makeDrizzleChatRepository(container.getDb().sql)
  await runChatRoomFanout(
    {
      loadMessage: (job) =>
        job.kind === "group"
          ? chatRepo.findGroupMessage(job.roomId, job.messageId, null)
          : chatRepo.findReportMessage(job.roomId, job.messageId, null),
      fanoutDeps: makeContainerRoomFanoutDeps(container, logger),
    },
    data,
  )
}
