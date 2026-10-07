import type { UserChannel } from "@civfix/shared/interfaces"

/**
 * A room the user just joined or was added to otherwise only surfaces on the client's next manual
 * refresh. Carries no room id, so it is safe to fire at anyone whose membership may have changed.
 */
export function nudgeThreads(userChannel: UserChannel | undefined, userId: string): void {
  void Promise.resolve(userChannel?.publishToUser(userId, { topic: "threads" })).catch(() => {})
}
