export const MEDIA_CHECKS_JOB = "media.checks"
export const ANON_HOLD_RELEASE_JOB = "anon.hold.release"

// The API and the media worker both create media.checks and anon.hold.release with this policy. pg-boss
// keeps the last createQueue/updateQueue policy, so a mismatch silently breaks singletonKey dedup on
// those queues.
export const SHARED_QUEUE_POLICY = "short"

export const JURISDICTION_DISCOVERY_JOB = "jurisdiction.discovery"
export const OUTREACH_DIGEST_JOB = "outreach.digest"
export const INBOUND_SWEEP_JOB = "inbound.sweep"
export const DATA_EXPORT_JOB = "data.export"
export const CLEANUP_CANCEL_FANOUT_JOB = "cleanup.cancel.fanout"
export const CLEANUP_GUEST_UPDATE_FANOUT_JOB = "cleanup.guest.update.fanout"
export const GUEST_RETENTION_SWEEP_JOB = "guest.retention.sweep"
export const CHAT_ROOM_FANOUT_JOB = "chat.room.fanout"
export const WAITLIST_PROMOTE_JOB = "waitlist.promote"
export const WAITLIST_EXPIRE_SWEEP_JOB = "waitlist.expire.sweep"
export const CHECKIN_NOSHOW_SWEEP_JOB = "checkin.noshow.sweep"
export const BROADCAST_PLAN_JOB = "broadcast.plan"
export const BROADCAST_CHUNK_JOB = "broadcast.chunk"
export const BROADCAST_SCHEDULE_SWEEP_JOB = "broadcast.schedule.sweep"
export const EVENT_REMINDERS_SWEEP_JOB = "event.reminders.sweep"
export const EVENT_METRICS_ROLLUP_JOB = "event.metrics.rollup"
export const HOST_EXPORT_JOB = "host.export"
export const HOST_EXPORT_REAP_JOB = "host.export.reap"
export const HOST_RETENTION_SWEEP_JOB = "host.retention.sweep"

export const ORPHAN_SWEEP_JOB = "orphan.sweep"
export const CHAT_PARTITION_JOB = "chat.partition.maintenance"
export const ANON_HOLD_RELEASE_SWEEP_JOB = "anon.hold.release.sweep"
export const RETENTION_SWEEP_JOB = "retention.sweep"
export const MEDIA_STUCK_SWEEP_JOB = "media.stuck.sweep"
export const MEDIA_UPLOAD_REAP_JOB = "media.upload.reap"

// City filing (DECISIONS §64). The API creates all six queues; the filer creates the ones it touches with
// the same options, since pg-boss keeps whichever createQueue/updateQueue ran last.
export const FILING_EMAIL_JOB = "filing.email"
export const FILING_RUN_JOB = "filing.run"
export const FILING_RESULT_JOB = "filing.result"
export const FILING_CLASSIFY_JOB = "filing.classify"
export const FILING_CITY_UPDATE_JOB = "filing.city_update"
export const FILING_SWEEP_JOB = "filing.sweep"

export type FilingQueueName =
  | typeof FILING_EMAIL_JOB
  | typeof FILING_RUN_JOB
  | typeof FILING_RESULT_JOB
  | typeof FILING_CLASSIFY_JOB
  | typeof FILING_CITY_UPDATE_JOB
  | typeof FILING_SWEEP_JOB

export interface FilingQueueOptions {
  policy: typeof SHARED_QUEUE_POLICY
  retryLimit: number
  retryDelay?: number
  retryBackoff?: boolean
  expireInSeconds?: number
}

// A portal run is never retried by pg-boss: the filer records its own outcome (D6), and a second run of
// a submit that may have landed would file the report twice.
export const FILING_QUEUE_OPTIONS: Readonly<Record<FilingQueueName, FilingQueueOptions>> = {
  [FILING_EMAIL_JOB]: { policy: SHARED_QUEUE_POLICY, retryLimit: 2, retryDelay: 60 },
  [FILING_RUN_JOB]: { policy: SHARED_QUEUE_POLICY, retryLimit: 0, expireInSeconds: 3600 },
  [FILING_RESULT_JOB]: {
    policy: SHARED_QUEUE_POLICY,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
  },
  [FILING_CLASSIFY_JOB]: { policy: SHARED_QUEUE_POLICY, retryLimit: 1 },
  [FILING_CITY_UPDATE_JOB]: {
    policy: SHARED_QUEUE_POLICY,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
  },
  [FILING_SWEEP_JOB]: { policy: SHARED_QUEUE_POLICY, retryLimit: 0 },
}
