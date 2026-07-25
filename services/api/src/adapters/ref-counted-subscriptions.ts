/**
 * ONE ref-counted subscription registry for the realtime adapters.
 *
 * RedisChatPubSub (channel -> handlers), WsChatService (room -> sockets) and RedisUserChannel
 * (user -> sockets) all need the same machinery: a Map keyed by channel, an upstream SUBSCRIBE issued only
 * for the FIRST member, an UNSUBSCRIBE when the LAST member leaves, and idempotent release closures. Three
 * hand-maintained copies of that is three chances to get the concurrency wrong — and one of them did: a
 * rejected first SUBSCRIBE left an EMPTY entry in the map, so every later join saw a live-looking entry,
 * skipped the upstream SUBSCRIBE, and attached to a channel the upstream never delivers. That is permanent
 * silent message loss for the room on that worker, and it survives every retry.
 *
 * The two invariants that fix it, enforced here once:
 *
 *   1. The entry is inserted BEFORE the upstream subscribe is awaited, and the in-flight subscribe is kept
 *      as a `ready` promise every concurrent adder awaits. So concurrent first-adds share exactly ONE
 *      upstream subscribe (no leaked teardown handle), and they all see the same outcome.
 *   2. If that subscribe REJECTS, the entry is removed and the rejection propagates to every waiter. No
 *      caller believes it is subscribed, and the next add starts a genuinely fresh subscribe.
 *
 * The upstream `open` callback receives a LIVE accessor for the key's members (not a snapshot), so a
 * delivery callback always iterates the current set — a member that left mid-delivery is not written to.
 */

/** Tear down one upstream subscription. */
export type SubscriptionTeardown = () => Promise<void>

/**
 * Open the upstream subscription for `key`. `members()` returns the key's live member set for the delivery
 * callback to iterate. Resolves to the upstream teardown; rejects if the subscribe failed.
 */
export type OpenSubscription<M> = (
  key: string,
  members: () => ReadonlySet<M>,
) => Promise<SubscriptionTeardown>

interface Entry<M> {
  readonly members: Set<M>
  /** Resolves once the upstream subscribe succeeded; rejects with its error if it failed. */
  ready: Promise<void>
  /** True once `ready` has resolved, so an add on a live key needs no await at all. */
  open: boolean
  teardown: SubscriptionTeardown
}

export class RefCountedSubscriptions<M> {
  private readonly entries = new Map<string, Entry<M>>()
  private readonly openUpstream: OpenSubscription<M>

  constructor(open: OpenSubscription<M>) {
    this.openUpstream = open
  }

  /**
   * Add a member to `key`, opening the upstream subscription on the first one. Returns an idempotent
   * release closure that removes THIS member (and unsubscribes when it was the last). Rejects — without
   * registering the member — when the upstream subscribe fails.
   */
  async add(key: string, member: M): Promise<SubscriptionTeardown> {
    for (;;) {
      const entry = this.entries.get(key) ?? this.openEntry(key)
      if (!entry.open) {
        // Every adder (including concurrent ones) awaits the SAME in-flight subscribe and shares its
        // outcome — a rejection reaches all of them, so none believes it is subscribed.
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

  /** Create the entry and start its upstream subscribe. Registered in the map BEFORE the await. */
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

  /**
   * Remove a member by (key, member) — for callers that do not hold the release closure. Unsubscribes when
   * the key's last member leaves. A member/key that is not registered is a no-op.
   */
  async remove(key: string, member: M): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    await this.removeFrom(key, member, entry)
  }

  /** The key's live member set, or undefined when nothing is subscribed (used by demux delivery). */
  membersOf(key: string): ReadonlySet<M> | undefined {
    return this.entries.get(key)?.members
  }

  /** Number of members on `key` (0 when unsubscribed). */
  size(key: string): number {
    return this.entries.get(key)?.members.size ?? 0
  }

  /** Number of keys with at least one member. */
  get keyCount(): number {
    return this.entries.size
  }

  /**
   * Tear down every upstream subscription and drop all entries (shutdown). allSettled, not all: one
   * rejected teardown must not abort the rest or leave entries behind. An entry whose subscribe is still
   * IN FLIGHT is dropped without waiting for it — a hung upstream must not hold up SIGTERM.
   */
  async closeAll(): Promise<void> {
    const teardowns = [...this.entries.values()].map((e) => e.teardown())
    this.entries.clear()
    await Promise.allSettled(teardowns)
  }

  /**
   * Drop all entries WITHOUT calling the upstream teardowns — for an owner that closes the whole upstream
   * transport itself (a per-channel UNSUBSCRIBE on a connection about to be disconnected is pointless).
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
