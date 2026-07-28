/**
 * English (source) catalog for SERVER-generated, user-facing copy. This is the source of truth; es/de/ko
 * are translated from these strings key-by-key and fall back here for any missing key.
 *
 * SCOPE (per the i18n design spec §4 + worklist-backend.json):
 *   - backend-notifications: push/bell titles + bodies (DM, mention, comment/reply, follower).
 *   - backend-emails: account/OTP email subjects + bodies.
 * EXCLUDED: jurisdiction report-packet emails (mail-format.ts) stay English (recipients are officials),
 * and validation errors are conveyed by stable error CODES (clients localize by code), not message text.
 *
 * Interpolation uses `{{var}}` placeholders (see renderMessage). User-authored content echoed into a
 * notification body (a DM/mention preview) is passed as a `{{preview}}` var and truncated by the caller;
 * only the surrounding wrapper copy is translated.
 */

export type MessageCatalog = Record<string, string>

export const en = {
  // ---- Push / in-app bell notifications (backend-notifications) ----------------------------------
  // New follower (social-service onNewFollower). {{name}} = follower @handle/display name.
  "notification.follower.title": "New follower",
  "notification.follower.body": "{{name}} started following you.",

  // Report-discussion comment on your report (discussion.routes notifyOnMessage, top-level comment).
  "notification.comment.title": "New comment on your report",
  "notification.comment.body": "Someone commented on your report.",

  // Report-discussion reply to your comment.
  "notification.reply.title": "New reply on your comment",
  "notification.reply.body": "Someone replied to your comment.",

  // You were @-mentioned in a report discussion (discussion.routes notifyMention).
  "notification.report_mention.title": "You were mentioned",
  "notification.report_mention.body": "Someone mentioned you in a report discussion.",

  // Social-feed post interactions (notification-service onPostLike/Repost/Reply/Quote/Mention).
  // {{name}} = the actor's display name / @handle.
  "notification.post.like.title": "New like",
  "notification.post.like.body": "{{name}} liked your post.",
  "notification.post.repost.title": "New repost",
  "notification.post.repost.body": "{{name}} reposted your post.",
  "notification.post.reply.title": "New reply",
  "notification.post.reply.body": "{{name}} replied to your post.",
  "notification.post.quote.title": "New quote",
  "notification.post.quote.body": "{{name}} quoted your post.",
  "notification.post.mention.title": "{{name}} mentioned you",
  "notification.post.mention.body": "{{name}} mentioned you in a post.",

  // @-mention in a cleanup/report group chat (chat-bells makeChatMentionNotifier). {{name}} = author handle/name.
  "notification.chat_mention.title": "{{name}} mentioned you",
  // Reply to YOUR message in any chat room (chat-bells makeChatReplyNotifier / makeDmBellNotifier,
  // P2 2.5 — the bell that pierces conversation mutes). {{name}} = author handle/name.
  "notification.chat_reply.title": "{{name}} replied to you",
  // Direct message delivered bell (chat-gateway-wiring onDmDelivered). {{name}} = sender handle/name.
  // {{preview}} = the caller-truncated message preview (user content); the wrapper is what we localize.
  "notification.dm.title": "{{name}}",
  "notification.dm.title_fallback": "New message",
  // Report-chat member bell (report-chat-notifier). Title fallback for a SYSTEM / author-less report
  // message (e.g. a status/timeline event) that has no sender name to show.
  "notification.report_chat.title_fallback": "New message",
  "notification.group_chat.title_fallback": "New message",
  // Body shown when the message has no text preview (a non-text frame: share_pin / rsvp / task_complete).
  "notification.message.no_preview": "Sent you a message",

  // Cleanup membership-role bells (WS4, type 'cleanup_role'): the organizer promoted/demoted you, or a
  // host removed you from the event. {{title}} = the event title.
  "notification.cleanup_role.promoted.title": "You're now a co-host",
  "notification.cleanup_role.promoted.body": "You're now a co-host of {{title}}.",
  "notification.cleanup_role.demoted.title": "Co-host role removed",
  "notification.cleanup_role.demoted.body": "You're no longer a co-host of {{title}}.",
  "notification.cleanup_role.removed.title": "Removed from event",
  "notification.cleanup_role.removed.body": "You were removed from {{title}}.",

  // Event-cancellation bell (L24, type 'cleanup_cancelled'): the host called the event off. Fanned out to
  // every OTHER member by cleanup-service.notifyCancellation. The reason is OPTIONAL on the wire, so there
  // are two bodies rather than one with an empty tail; {{reason}} is the host's own words (user content,
  // slur-gated by assertEventTextClean) and only the wrapper copy is translated.
  "notification.cleanup_cancelled.title": "Event cancelled",
  "notification.cleanup_cancelled.body": "This event has been cancelled by the host.",
  "notification.cleanup_cancelled.body_reason":
    "This event has been cancelled by the host. Reason: {{reason}}",

  // Service-hours credit bell (P4/B33, type 'hours_logged'): a verified host logged hours for a completed
  // event and you were credited. Fired by volunteer-hours-service.logEventHours ONLY when the credit is
  // NEW or has INCREASED — re-logging is how a host fixes a typo, and a downward correction is
  // deliberately silent. {{hours}} = the credited amount, {{title}} = the event title.
  "notification.hours_logged.title": "Service hours credited",
  "notification.hours_logged.body": "{{hours}} hours were credited for {{title}}.",

  // Event-slot bell (P4/B34, type 'cleanup_slot'): the host edited the event's roles and the one you had
  // claimed no longer exists, so you are back in the crew with no role. Fired by cleanup-service's slot
  // reconciliation; the actor is excluded. {{slot}} = the removed role's title, {{title}} = the event.
  // (There is deliberately NO "slot claimed" bell to the host — see B35.)
  "notification.cleanup_slot.removed.title": "Your event role changed",
  "notification.cleanup_slot.removed.body": 'The "{{slot}}" role was removed from {{title}}.',

  // ---- Account / OTP emails (backend-emails) -----------------------------------------------------
  // Sign-in passcode email. {{code}} = the numeric OTP.
  "email.otp.subject": "Your civfix sign-in code",
  "email.otp.body_line1": "Your civfix sign-in code is {{code}}.",
  "email.otp.body_expiry": "It expires in 5 minutes. If you did not request it, you can ignore this email.",
  // HTML-variant intro (the code itself is rendered in a styled block by the template).
  "email.otp.html_intro": "Your civfix sign-in code is:",

  // Report status-update transactional email. {{status}} = localized/raw status label.
  "email.report_update.subject": "Your civfix report was {{status}}",
  "email.report_update.body": "Your report has a new status: {{status}}.",

  // Generic transactional fallback (unknown template). {{subject}}/{{message}} supplied by the caller.
  "email.generic.subject": "A civfix notification",
  "email.generic.body": "You have a new civfix notification.",
} satisfies MessageCatalog

/** The exhaustive set of message keys, derived from the EN source so es/de/ko can be checked complete. */
export type MessageKey = keyof typeof en
