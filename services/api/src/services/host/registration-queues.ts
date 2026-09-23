export const WAITLIST_PROMOTE_JOB = "waitlist.promote"

export const WAITLIST_EXPIRE_SWEEP_JOB = "waitlist.expire.sweep"

export const CHECKIN_NOSHOW_SWEEP_JOB = "checkin.noshow.sweep"

export const REGISTRATION_QUEUE_NAMES = [
  WAITLIST_PROMOTE_JOB,
  WAITLIST_EXPIRE_SWEEP_JOB,
  CHECKIN_NOSHOW_SWEEP_JOB,
] as const
