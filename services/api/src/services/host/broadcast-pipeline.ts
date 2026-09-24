import type { BroadcastKind } from "@civfix/shared"
import { ANNOUNCEMENT_BROADCAST_KIND } from "@civfix/shared"
import type { Mailer } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { CacheClient } from "../../auth/cache.js"
import type { AdminAuditAction } from "../admin/audit.js"
import type { NotificationService } from "../notification-service.js"
import { makeInsightsGeneration } from "./host-analytics-cache.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type {
  BroadcastRecipientKind,
  BroadcastRecord,
  DeliveryOutcome,
  DeliveryRowInput,
} from "./broadcast-types.js"
import { MAX_DELIVERY_ATTEMPTS } from "./broadcast-types.js"
import { audiencePages } from "./broadcast-audience.js"
import { ChunkAuthAbort, makeBroadcastEmailSender } from "./broadcast-email-sender.js"
import { makeBroadcastInAppSender } from "./broadcast-inapp-sender.js"
import { makeBroadcastLifecycle } from "./broadcast-lifecycle.js"
import {
  BroadcastCapError,
  type BroadcastConfig,
  type BroadcastService,
} from "./broadcast-service.js"

export { KIND_NOTIFICATION_TYPE } from "./broadcast-inapp-sender.js"
export { announcementPath, notificationLink } from "./broadcast-render.js"

const CHUNK_STALE_MS = 10 * 60 * 1000
const SENDING_STALE_MS = 5 * 60 * 1000
export const AUTH_ABORT_BACKOFF_SEC = [60, 300, 900] as const
const DELIVERY_INSERT_BATCH = 500
// A chunk holds chunkSize recipients, each with at most one row per channel (inapp, push, email, sms).
const MAX_CHANNELS_PER_RECIPIENT = 4
const SCHEDULE_SWEEP_LIMIT = 50
const STALE_SWEEP_LIMIT = 20
const BUDGETED_KINDS: ReadonlySet<BroadcastKind> = new Set<BroadcastKind>([
  "host_broadcast",
  ANNOUNCEMENT_BROADCAST_KIND,
])

export interface BroadcastPipelineDeps {
  repo: BroadcastRepository
  service: BroadcastService
  notifications: NotificationService
  mailer: Mailer
  cache: CacheClient
  config: BroadcastConfig
  mailDomain: string
  enqueueChunk: (
    broadcastId: string,
    chunkNo: number,
    opts?: { startAfterSec?: number; authRetry?: number },
  ) => Promise<void>
  audit: (
    action: AdminAuditAction,
    actorId: string | null,
    target: string,
    meta: Record<string, unknown>,
  ) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
  now?: () => Date
}

export interface PlanOutcome {
  kind: "planned" | "skipped" | "killed" | "org_suspended" | "too_many" | "over_budget" | "empty"
  recipients?: number
  chunks?: number
}

function deliveryRowsFor(
  record: BroadcastRecord,
  memberIds: readonly string[],
  guestIds: readonly string[],
): DeliveryRowInput[] {
  const chunkSize = Math.max(1, record.chunkSize)
  const rows: DeliveryRowInput[] = []
  const recipients: Array<{ kind: BroadcastRecipientKind; id: string }> = [
    ...memberIds.map((id) => ({ kind: "member" as const, id })),
    ...guestIds.map((id) => ({ kind: "guest" as const, id })),
  ]
  recipients.forEach((recipient, index) => {
    const chunkNo = Math.floor(index / chunkSize)
    for (const channel of record.channels) {
      if (recipient.kind === "guest" && channel !== "email" && channel !== "sms") continue
      rows.push({
        broadcastId: record.id,
        chunkNo,
        recipientKind: recipient.kind,
        userId: recipient.kind === "member" ? recipient.id : null,
        guestId: recipient.kind === "guest" ? recipient.id : null,
        channel,
      })
    }
  })
  return rows
}

export function makeBroadcastPipeline(deps: BroadcastPipelineDeps) {
  const now = deps.now ?? (() => new Date())
  const { repo, config } = deps
  const optionalLogger = deps.logger !== undefined ? { logger: deps.logger } : {}
  const insights = makeInsightsGeneration({ cache: deps.cache, ...optionalLogger })
  const lifecycle = makeBroadcastLifecycle({
    repo,
    config,
    insights,
    audit: deps.audit,
    now,
    ...optionalLogger,
  })
  const inApp = makeBroadcastInAppSender({
    repo,
    config,
    notifications: deps.notifications,
    now,
    ...optionalLogger,
  })
  const email = makeBroadcastEmailSender({
    repo,
    config,
    mailer: deps.mailer,
    cache: deps.cache,
    mailDomain: deps.mailDomain,
    now,
    ...optionalLogger,
  })

  async function collectAudience(
    record: BroadcastRecord,
  ): Promise<{ memberIds: string[]; guestIds: string[] }> {
    const memberIds: string[] = []
    const guestIds: string[] = []
    const scope = {
      cleanupId: record.cleanupId,
      segment: record.segment ?? { kind: "all_registered" as const },
      kind: record.kind,
    }
    for await (const page of audiencePages(repo, scope)) {
      memberIds.push(...page.members)
      guestIds.push(...page.guests)
      if (memberIds.length + guestIds.length > config.maxRecipients) break
    }
    return { memberIds, guestIds }
  }

  async function failPlan(record: BroadcastRecord): Promise<void> {
    await repo.transition(record.id, ["sending"], "failed", { finishedAt: now() })
    await insights.bumpInsightsGeneration(record.cleanupId)
  }

  /** False when the host's daily recipient budget refused the send and the plan was failed. */
  async function chargeRecipientBudget(
    record: BroadcastRecord,
    recipientCount: number,
    reservedNow: boolean,
  ): Promise<boolean> {
    if (!reservedNow || record.createdBy === null || !BUDGETED_KINDS.has(record.kind)) return true
    if (await deps.service.reserveRecipientBudget(record.createdBy, recipientCount)) return true
    await repo.suppressRemaining(record.id, "cap")
    await failPlan(record)
    deps.logger?.warn(
      { evt: "broadcast.failed", broadcastId: record.id, reason: "recipients_per_day" },
      "broadcast refused: host daily recipient budget exhausted",
    )
    return false
  }

  async function plan(broadcastId: string): Promise<PlanOutcome> {
    const record = await repo.findById(broadcastId)
    if (record === null || record.status !== "sending") return { kind: "skipped" }
    if (await lifecycle.killed(record)) {
      await lifecycle.killBroadcast(record, "kill_switch")
      return { kind: "killed" }
    }
    if (await lifecycle.organizationSuspendedFor(record)) {
      const failed = await lifecycle.failForSuspendedOrganization(record, "sending", now())
      return { kind: failed ? "org_suspended" : "skipped" }
    }

    const { memberIds, guestIds } = await collectAudience(record)
    const recipientCount = memberIds.length + guestIds.length
    if (recipientCount > config.maxRecipients) {
      await failPlan(record)
      deps.logger?.error(
        { evt: "broadcast.failed", broadcastId: record.id, recipientCount, reason: "too_many" },
        "broadcast refused: audience above the platform cap",
      )
      return { kind: "too_many", recipients: recipientCount }
    }
    if (recipientCount === 0) {
      await repo.markPlanned(record.id, { recipientCount: 0, plannedAt: now() })
      await repo.transition(record.id, ["sending"], "sent", { finishedAt: now() })
      await insights.bumpInsightsGeneration(record.cleanupId)
      return { kind: "empty", recipients: 0 }
    }

    const rows = deliveryRowsFor(record, memberIds, guestIds)
    for (let i = 0; i < rows.length; i += DELIVERY_INSERT_BATCH) {
      await repo.insertDeliveries(rows.slice(i, i + DELIVERY_INSERT_BATCH))
    }

    const reservedNow = await repo.markPlanned(record.id, { recipientCount, plannedAt: now() })
    if (!(await chargeRecipientBudget(record, recipientCount, reservedNow))) {
      return { kind: "over_budget", recipients: recipientCount }
    }

    await insights.bumpInsightsGeneration(record.cleanupId)
    const chunkNos = await repo.listPendingChunks(record.id)
    for (const chunkNo of chunkNos) {
      await deps.enqueueChunk(record.id, chunkNo)
    }
    deps.logger?.info(
      {
        evt: "broadcast.plan.done",
        broadcastId: record.id,
        cleanupId: record.cleanupId,
        recipientCount,
        chunkCount: chunkNos.length,
      },
      "broadcast planned",
    )
    return { kind: "planned", recipients: recipientCount, chunks: chunkNos.length }
  }

  async function runChunk(broadcastId: string, chunkNo: number, authRetry = 0): Promise<void> {
    const record = await repo.findById(broadcastId)
    if (record === null || record.status !== "sending") return
    if (await lifecycle.killed(record)) {
      await lifecycle.killBroadcast(record, "kill_switch_mid_send")
      return
    }
    const event = await repo.eventContext(record.cleanupId)
    if (event === null) return
    // An operator can suspend the organization after plan() passed; every chunk rechecks so the
    // suspension stops what is still pending rather than only the next broadcast.
    if (lifecycle.organizationSuspendedIn(record, event)) {
      await lifecycle.failForSuspendedOrganization(record, "sending", now())
      return
    }

    const claims = await repo.claimChunk({
      broadcastId,
      chunkNo,
      staleBefore: new Date(now().getTime() - CHUNK_STALE_MS),
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      limit: Math.max(1, record.chunkSize) * MAX_CHANNELS_PER_RECIPIENT,
    })
    if (claims.length === 0) {
      await finalizeIfDrained(record)
      return
    }

    const outcomes: DeliveryOutcome[] = []
    let aborted: ChunkAuthAbort | null = null
    try {
      await inApp.runInAppAndPush(record, event, claims, outcomes)
      await email.runEmail(record, event, claims, outcomes)
    } catch (err) {
      if (!(err instanceof ChunkAuthAbort)) throw err
      aborted = err
    } finally {
      await repo.applyDeliveryOutcomes(outcomes)
      await repo.refreshCounts(broadcastId)
    }
    if (aborted !== null) {
      await repo.releaseClaims(aborted.releasedIds)
      await backOffAfterAuthAbort(broadcastId, chunkNo, authRetry, aborted.cause)
      return
    }
    await finalizeIfDrained(record)
    deps.logger?.info(
      {
        evt: "broadcast.chunk.done",
        broadcastId,
        chunkNo,
        claimed: claims.length,
        applied: outcomes.length,
      },
      "broadcast chunk complete",
    )
  }

  async function backOffAfterAuthAbort(
    broadcastId: string,
    chunkNo: number,
    authRetry: number,
    err: unknown,
  ): Promise<void> {
    const startAfterSec = AUTH_ABORT_BACKOFF_SEC[authRetry]
    if (startAfterSec === undefined) {
      deps.logger?.error(
        { err, evt: "broadcast.chunk.auth_abort", broadcastId, chunkNo, authRetry },
        "broadcast chunk aborted on an SMTP sender rejection and is out of backoff attempts",
      )
      throw err
    }
    deps.logger?.warn(
      { err, evt: "broadcast.chunk.auth_abort", broadcastId, chunkNo, authRetry, startAfterSec },
      "broadcast chunk aborted on an SMTP sender rejection; claims released, retrying after backoff",
    )
    await deps.enqueueChunk(broadcastId, chunkNo, { startAfterSec, authRetry: authRetry + 1 })
  }

  async function finalizeIfDrained(record: BroadcastRecord): Promise<void> {
    const terminalized = await repo.failExhausted(record.id, MAX_DELIVERY_ATTEMPTS)
    if (terminalized > 0) {
      await repo.refreshCounts(record.id)
      deps.logger?.warn(
        { evt: "broadcast.exhausted", broadcastId: record.id, terminalized },
        "broadcast: deliveries out of attempts marked failed",
      )
    }
    const counts = await repo.deliveryCounts(record.id)
    if (counts.pending > 0) return
    const allFailed = counts.sent === 0 && counts.failed > 0
    const finished = await repo.transition(record.id, ["sending"], allFailed ? "failed" : "sent", {
      finishedAt: now(),
    })
    await repo.refreshCounts(record.id)
    if (finished !== null) await insights.bumpInsightsGeneration(record.cleanupId)
  }

  /** True hands the broadcast on to plan(), which kills it; false ends the release here. */
  async function refuseAtRelease(
    id: string,
    cleanupId: string,
    err: BroadcastCapError,
    at: Date,
  ): Promise<boolean> {
    if (err.kind === "kill_switch" || err.kind === "suspended") return true
    if (err.kind === "counter_unavailable") {
      await repo.transition(id, ["sending"], "scheduled", { startedAt: null })
      deps.logger?.warn(
        { evt: "broadcast.release.deferred", broadcastId: id },
        "scheduled broadcast returned to scheduled: cap counters unavailable, retrying next sweep",
      )
      return false
    }
    await repo.suppressRemaining(id, "cap")
    await repo.transition(id, ["sending"], "failed", { finishedAt: at })
    await repo.refreshCounts(id)
    await insights.bumpInsightsGeneration(cleanupId)
    deps.logger?.warn(
      { evt: "broadcast.failed", broadcastId: id, reason: err.kind },
      "scheduled broadcast refused at release: send-slot cap",
    )
    return false
  }

  async function releaseScheduled(id: string, at: Date): Promise<boolean> {
    const due = await repo.findById(id)
    if (due === null || due.status !== "scheduled") return false
    if (await lifecycle.organizationSuspendedFor(due)) {
      await lifecycle.failForSuspendedOrganization(due, "scheduled", at)
      return false
    }
    const moved = await repo.transition(id, ["scheduled"], "sending", { startedAt: at })
    if (moved === null) return false
    if (moved.createdBy !== null && moved.kind === "host_broadcast") {
      try {
        await deps.service.reserveSendSlot(moved.cleanupId, moved.createdBy)
      } catch (err) {
        if (!(err instanceof BroadcastCapError)) throw err
        if (!(await refuseAtRelease(id, moved.cleanupId, err, at))) return false
      }
    }
    await plan(id)
    return true
  }

  async function resumeStale(id: string): Promise<boolean> {
    const record = await repo.findById(id)
    if (record === null) return false
    if (record.plannedAt === null) {
      await plan(id)
      return true
    }
    const counts = await repo.deliveryCounts(id)
    if (counts.pending === 0) {
      await finalizeIfDrained(record)
      return false
    }
    for (const chunkNo of await repo.listPendingChunks(id)) {
      await deps.enqueueChunk(id, chunkNo)
    }
    return true
  }

  async function sweep(): Promise<{ released: number; resumed: number }> {
    const at = now()
    const due = await repo.listDueScheduled(at, SCHEDULE_SWEEP_LIMIT)
    let released = 0
    for (const id of due) {
      if (await releaseScheduled(id, at)) released += 1
    }
    const stale = await repo.listStaleSending(
      new Date(at.getTime() - SENDING_STALE_MS),
      STALE_SWEEP_LIMIT,
    )
    let resumed = 0
    for (const id of stale) {
      if (await resumeStale(id)) resumed += 1
    }
    return { released, resumed }
  }

  return { plan, runChunk, sweep, finalizeIfDrained }
}

export type BroadcastPipeline = ReturnType<typeof makeBroadcastPipeline>
