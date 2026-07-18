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
  // Body shown when the message has no text preview (a non-text frame: share_pin / rsvp / task_complete).
  "notification.message.no_preview": "Sent you a message",

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
