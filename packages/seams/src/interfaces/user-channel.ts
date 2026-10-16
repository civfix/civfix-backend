import type { ChatConnection } from "./chat-service.js"
import type { UserSignal } from "@civfix/contract"

/**
 * Per-user realtime signal fan-out behind a vendor-neutral interface.
 *
 * A separate seam from `ChatService` because per-user invalidate events are a distinct concern from chat
 * ROOMS: a consumer wanting "tell this user to refetch" should not depend on join/persist/history. A
 * connection is addressed by `userId` and stays "always joined" for the socket's whole lifetime, so
 * `subscribeUser` returns an async unsubscribe handle and the gateway holds exactly one disposer per
 * socket. A frame carries only a topic + optional scoping id, never entity data; the client refetches
 * authoritative state once it learns a domain is stale.
 */
export interface UserChannel {
  /** Register conn (held by userId) to receive this user's signal frames on THIS worker. Returns an
   *  async unsubscribe handle. Idempotent per connection. Addressed by userId (not roomId): the user is
   *  "always joined" for the socket's whole lifetime. */
  subscribeUser(userId: string, conn: ChatConnection): Promise<() => Promise<void>>
  /** Publish a signal to every live connection userId holds, across all workers. Best-effort. */
  publishToUser(userId: string, signal: UserSignal): Promise<void>
  /** Fan a signal to many users (e.g. all cleanup members on a new message). Best-effort. */
  publishToUsers(userIds: readonly string[], signal: UserSignal): Promise<void>
  /** Tear down owned resources (per-user subscriptions). Safe to call once at shutdown. */
  close(): Promise<void>
}
