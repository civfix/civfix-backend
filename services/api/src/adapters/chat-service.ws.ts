import type {
  ChatService,
  ChatConnection,
  PersistChatInput,
  ChatHistoryPage,
} from "@civfix/shared/interfaces"
import type { ChatMessageDTO, WsServerMessage } from "@civfix/shared"
import { randomUUID } from "node:crypto"
import { chatChannel, type ChatPubSub } from "./chat-pubsub.js"
import { RefCountedSubscriptions } from "./ref-counted-subscriptions.js"
import type { ChatRepository } from "../services/chat-repository.drizzle.js"

export interface WsChatServiceDeps {
  repo: ChatRepository
  pubsub: ChatPubSub
  newId?: () => string
}

export class WsChatService implements ChatService {
  private readonly repo: ChatRepository
  private readonly pubsub: ChatPubSub
  private readonly newId: () => string
  private readonly rooms: RefCountedSubscriptions<ChatConnection>

  constructor(deps: WsChatServiceDeps) {
    this.repo = deps.repo
    this.pubsub = deps.pubsub
    this.newId = deps.newId ?? (() => randomUUID())
    this.rooms = new RefCountedSubscriptions<ChatConnection>((cleanupId, connections) =>
      this.pubsub.subscribe(chatChannel(cleanupId), (payload) => {
        const { frame, excludeConnId } = decodeEnvelope(payload)
        for (const c of [...connections()]) {
          if (excludeConnId !== undefined && c.id === excludeConnId) continue
          c.send(frame)
        }
      }),
    )
  }

  async joinRoom(cleanupId: string, conn: ChatConnection, _userId: string): Promise<void> {
    await this.rooms.add(cleanupId, conn)
  }

  async leaveRoom(cleanupId: string, conn: ChatConnection): Promise<void> {
    await this.rooms.remove(cleanupId, conn)
  }

  async broadcast(
    cleanupId: string,
    msg: ChatMessageDTO,
    opts?: { excludeConnId?: string },
  ): Promise<void> {
    await this.publishFrame(cleanupId, { type: "message", message: msg }, opts?.excludeConnId)
  }

  async broadcastEvent(
    cleanupId: string,
    frame: WsServerMessage,
    opts?: { excludeConnId?: string },
  ): Promise<void> {
    await this.publishFrame(cleanupId, frame, opts?.excludeConnId)
  }

  private async publishFrame(
    cleanupId: string,
    frame: WsServerMessage,
    excludeConnId: string | undefined,
  ): Promise<void> {
    const envelope = JSON.stringify({
      frame,
      ...(excludeConnId !== undefined ? { excludeConnId } : {}),
    })
    await this.pubsub.publish(chatChannel(cleanupId), envelope)
  }

  deliverLocal(
    cleanupId: string,
    frame: WsServerMessage,
    excludeConnId: string | undefined,
  ): number {
    const payload = JSON.stringify(frame)
    let delivered = 0
    for (const c of [...(this.rooms.membersOf(cleanupId) ?? [])]) {
      if (excludeConnId !== undefined && c.id === excludeConnId) continue
      c.send(payload)
      delivered += 1
    }
    return delivered
  }

  persist(input: PersistChatInput): Promise<ChatMessageDTO> {
    return this.repo.insertMessage(input, this.newId())
  }

  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    return this.repo.history(cleanupId, before, limit, viewerUserId, around)
  }

  async close(): Promise<void> {
    await this.rooms.closeAll()
  }

  roomSize(cleanupId: string): number {
    return this.rooms.size(cleanupId)
  }
}

function decodeEnvelope(payload: string): { frame: string; excludeConnId: string | undefined } {
  try {
    const parsed = JSON.parse(payload) as {
      frame?: unknown
      type?: unknown
      message?: unknown
      excludeConnId?: unknown
    }
    const excludeConnId =
      typeof parsed.excludeConnId === "string" ? parsed.excludeConnId : undefined
    if (parsed.frame !== undefined && parsed.frame !== null && typeof parsed.frame === "object") {
      return { frame: JSON.stringify(parsed.frame), excludeConnId }
    }
    if (parsed.type === "message" && parsed.message !== undefined) {
      return { frame: JSON.stringify({ type: "message", message: parsed.message }), excludeConnId }
    }
  } catch {
    // Not a JSON envelope: the payload is already a bare frame and is forwarded as-is.
  }
  return { frame: payload, excludeConnId: undefined }
}
