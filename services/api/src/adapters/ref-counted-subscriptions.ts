/**
 * Shared by RedisChatPubSub, WsChatService and RedisUserChannel so the concurrency is right in one place.
 * A hand-maintained copy once let a rejected first SUBSCRIBE leave an EMPTY entry in the map: every later
 * join saw a live-looking entry, skipped the upstream SUBSCRIBE and attached to a channel that never
 * delivers, which is permanent silent message loss for that room on that worker.
 *
 * Invariants:
 *   1. The entry is inserted BEFORE the upstream subscribe is awaited and the in-flight subscribe is kept
 *      as a `ready` promise, so concurrent first-adds share exactly ONE upstream subscribe (no leaked
 *      teardown handle) and all see the same outcome.
 *   2. If that subscribe rejects, the entry is removed and the rejection reaches every waiter, so no caller
 *      believes it is subscribed and the next add starts a fresh subscribe.
 *
 * The upstream `open` callback gets a LIVE accessor for the key's members, not a snapshot, so a member that
 * left mid-delivery is not written to.
 */

export type SubscriptionTeardown = () => Promise<void>

export type OpenSubscription<M> = (
  key: string,
  members: () => ReadonlySet<M>,
) => Promise<SubscriptionTeardown>

interface Entry<M> {
  readonly members: Set<M>
  ready: Promise<void>
  /** Lets an add on a live key skip the await entirely. */
  open: boolean
  teardown: SubscriptionTeardown
}

export class RefCountedSubscriptions<M> {
  private readonly entries = new Map<string, Entry<M>>()
  private readonly openUpstream: OpenSubscription<M>

  constructor(open: OpenSubscription<M>) {
    this.openUpstream = open
  }

  async add(key: string, member: M): Promise<SubscriptionTeardown> {
    for (;;) {
      const entry = this.entries.get(key) ?? this.openEntry(key)
      if (!entry.open) {
        await entry.ready
        // The entry can be dropped while we await (its last member left and unsubscribed): starting over
        // is what keeps the member out of an orphaned set whose upstream is already gone.
        if (this.entries.get(key) !== entry) continue
      }
      entry.members.add(member)

      let released = false
      return async () => {
        if (released) return
        released = true
        await this.removeFrom(key, member, entry)
      }
    }
  }

  private openEntry(key: string): Entry<M> {
    const created: Entry<M> = {
      members: new Set<M>(),
      ready: Promise.resolve(),
      open: false,
      teardown: async () => {},
    }
    // Insert BEFORE awaiting so a concurrent first-add joins this entry instead of issuing a second
    // upstream subscribe and leaking the loser's teardown handle (TOCTOU).
    this.entries.set(key, created)
    created.ready = (async () => {
      try {
        created.teardown = await this.openUpstream(key, () => created.members)
        created.open = true
      } catch (err) {
        // Drop the phantom entry so the next add retries the upstream subscribe instead of attaching
        // members to a channel that will never deliver.
        if (this.entries.get(key) === created) this.entries.delete(key)
        throw err
      }
    })()
    return created
  }

  /** For callers that do not hold the release closure. */
  async remove(key: string, member: M): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    await this.removeFrom(key, member, entry)
  }

  membersOf(key: string): ReadonlySet<M> | undefined {
    return this.entries.get(key)?.members
  }

  size(key: string): number {
    return this.entries.get(key)?.members.size ?? 0
  }

  get keyCount(): number {
    return this.entries.size
  }

  /**
   * allSettled, not all: one rejected teardown must not abort the rest or leave entries behind. An entry
   * whose subscribe is still in flight is dropped without waiting for it, so a hung upstream cannot hold up
   * SIGTERM.
   */
  async closeAll(): Promise<void> {
    const teardowns = [...this.entries.values()].map((e) => e.teardown())
    this.entries.clear()
    await Promise.allSettled(teardowns)
  }

  /**
   * Skips the upstream teardowns, for an owner that closes the whole transport itself: a per-channel
   * UNSUBSCRIBE on a connection about to be disconnected is pointless.
   */
  clear(): void {
    this.entries.clear()
  }

  private async removeFrom(key: string, member: M, entry: Entry<M>): Promise<void> {
    const current = this.entries.get(key)
    if (current === undefined) return
    current.members.delete(member)
    if (current.members.size > 0) return
    // Only the entry we are actually holding may be dropped: a re-subscribe that already replaced it must
    // keep its own live upstream subscription.
    if (current !== entry) return
    this.entries.delete(key)
    await current.teardown()
  }
}
