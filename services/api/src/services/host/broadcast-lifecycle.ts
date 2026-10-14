import type { FastifyBaseLogger } from "fastify"
import type { AdminAuditAction } from "../admin/audit.js"
import type { InsightsInvalidator } from "./host-analytics-cache.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type { BroadcastRecord, EventBroadcastContext } from "./broadcast-types.js"
import { HOST_COMPOSED_BROADCAST_KINDS } from "./broadcast-types.js"
import type { BroadcastConfig } from "./broadcast-service.js"

const ORG_SUSPENDED_REASON = "org_suspended"
const KILLED_AUDIT_ACTION: AdminAuditAction = "event.broadcast_killed"

export interface BroadcastLifecycleDeps {
  repo: BroadcastRepository
  config: Pick<BroadcastConfig, "killSwitch">
  insights: InsightsInvalidator
  audit: (
    action: AdminAuditAction,
    actorId: string | null,
    target: string,
    meta: Record<string, unknown>,
  ) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "warn">
  now: () => Date
}

export function makeBroadcastLifecycle(deps: BroadcastLifecycleDeps) {
  const { repo, config, insights } = deps

  async function killed(record: BroadcastRecord): Promise<boolean> {
    if (config.killSwitch) return true
    if (record.createdBy === null) return false
    try {
      const state = await repo.hostMessagingState(record.createdBy)
      return state === null || state.suspended
    } catch (err) {
      deps.logger?.warn(
        { err, broadcastId: record.id },
        "broadcast: kill-switch read failed; treating as suspended (fail closed)",
      )
      return true
    }
  }

  async function killBroadcast(record: BroadcastRecord, reason: string): Promise<void> {
    const suppressed = await repo.suppressRemaining(record.id, "kill_switch")
    await repo.transition(record.id, ["draft", "scheduled", "sending"], "cancelled", {
      finishedAt: deps.now(),
    })
    await repo.refreshCounts(record.id)
    await insights.bumpInsightsGeneration(record.cleanupId)
    await deps.audit(KILLED_AUDIT_ACTION, record.createdBy, `broadcast:${record.id}`, {
      cleanupId: record.cleanupId,
      kind: record.kind,
      reason,
      suppressed,
    })
    deps.logger?.warn(
      { evt: "broadcast.killed", broadcastId: record.id, cleanupId: record.cleanupId, suppressed },
      "broadcast killed",
    )
  }

  /**
   * DECISIONS §32: an operator-suspended organization's events send no host-composed message, and a
   * release or a queued plan is a send just as much as the compose-time call was. Critical automated
   * notices (a cancellation, a changed time) stay deliverable: attendees must still hear about them.
   */
  function organizationSuspendedIn(
    record: BroadcastRecord,
    event: Pick<EventBroadcastContext, "organizationSuspended"> | null,
  ): boolean {
    return HOST_COMPOSED_BROADCAST_KINDS.has(record.kind) && event?.organizationSuspended === true
  }

  async function organizationSuspendedFor(record: BroadcastRecord): Promise<boolean> {
    if (!HOST_COMPOSED_BROADCAST_KINDS.has(record.kind)) return false
    return organizationSuspendedIn(record, await repo.eventContext(record.cleanupId))
  }

  async function failForSuspendedOrganization(
    record: BroadcastRecord,
    from: "scheduled" | "sending",
    at: Date,
  ): Promise<boolean> {
    const moved = await repo.transition(record.id, [from], "failed", { finishedAt: at })
    if (moved === null) return false
    const suppressed = await repo.suppressRemaining(record.id, "kill_switch")
    await repo.refreshCounts(record.id)
    await insights.bumpInsightsGeneration(record.cleanupId)
    await deps.audit(KILLED_AUDIT_ACTION, record.createdBy, `broadcast:${record.id}`, {
      cleanupId: record.cleanupId,
      kind: record.kind,
      reason: ORG_SUSPENDED_REASON,
      suppressed,
    })
    deps.logger?.warn(
      {
        evt: "broadcast.failed",
        broadcastId: record.id,
        cleanupId: record.cleanupId,
        reason: ORG_SUSPENDED_REASON,
      },
      "broadcast refused: the event's organization is suspended",
    )
    return true
  }

  return {
    killed,
    killBroadcast,
    organizationSuspendedIn,
    organizationSuspendedFor,
    failForSuspendedOrganization,
  }
}
