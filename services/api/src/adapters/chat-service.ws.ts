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
  logger?: { warn(obj: unknown, msg?: string): void }
}

interface DecodedEnvelope {
  frame: string
  excludeConnId: string | undefined
}

export class WsChatService implements ChatService {
  private readonly repo: ChatRepository
  private readonly pubsub: ChatPubSub
  private readonly newId: () => string
  private readonly logger: WsChatServiceDeps["logger"]
  private readonly rooms: RefCountedSubscriptions<ChatConnection>

  constructor(deps: WsChatServiceDeps) {
    this.repo = deps.repo
    this.pubsub = deps.pubsub
    this.newId = deps.newId ?? (() => randomUUID())
    this.logger = deps.logger
    this.rooms = new RefCountedSubscriptions<ChatConnection>((cleanupId, connections) => {
      const channel = chatChannel(cleanupId)
      return this.pubsub.subscribe(channel, (payload) => {
        const envelope = decodeEnvelope(payload)
        if (envelope === null) {
          // The payload is never logged: it can carry message bodies from any room member.
          this.logger?.warn(
            { channel },
            "chat: dropped a pub/sub payload that is not a frame envelope",
          )
          return
        }
        for (const c of [...connections()]) {
          if (envelope.excludeConnId !== undefined && c.id === envelope.excludeConnId) continue
          c.send(envelope.frame)
        }
      })
    })
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

// publishFrame is the only publisher on chat:<id>, so anything else on the channel is foreign and is
// dropped rather than forwarded unparsed to every socket in the room.
function decodeEnvelope(payload: string): DecodedEnvelope | null {
  let parsed: { frame?: unknown; excludeConnId?: unknown }
  try {
    parsed = JSON.parse(payload) as { frame?: unknown; excludeConnId?: unknown }
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  if (parsed.frame === null || typeof parsed.frame !== "object") return null
  return {
    frame: JSON.stringify(parsed.frame),
    excludeConnId: typeof parsed.excludeConnId === "string" ? parsed.excludeConnId : undefined,
  }
}
