/**
 * REAL ChatService adapter: WebSocket fan-out (@fastify/websocket) plus Postgres-backed history,
 * with Redis pub/sub for multi-instance broadcast.
 *
 * SCAFFOLD: bodies throw until a later step implements room management + persistence.
 *
 * Seam rule: the realtime transport SDK is confined to this file; domain code talks only to the
 * ChatService interface.
 */

import { AppError } from "@civfix/shared"
import type {
  ChatService,
  ChatConnection,
  PersistChatInput,
  ChatHistoryPage,
} from "@civfix/shared/interfaces"
import type { ChatMessageDTO } from "@civfix/shared"
import type { Db } from "../db/client.js"
import type { RedisClient } from "./redis.js"

export interface WsChatServiceDeps {
  db: Db
  redis: RedisClient
}

const NOT_IMPL = "adapter not implemented: chat-service.ws"

export class WsChatService implements ChatService {
  private readonly deps: WsChatServiceDeps

  constructor(deps: WsChatServiceDeps) {
    this.deps = deps
  }

  joinRoom(_cleanupId: string, _conn: ChatConnection, _userId: string): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  leaveRoom(_cleanupId: string, _conn: ChatConnection): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  broadcast(_cleanupId: string, _msg: ChatMessageDTO): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  persist(_input: PersistChatInput): Promise<ChatMessageDTO> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  history(
    _cleanupId: string,
    _before: string | undefined,
    _limit: number,
  ): Promise<ChatHistoryPage> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
