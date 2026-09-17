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

  "notification.event_team_invite.title": "You've been invited to help run an event",
  "notification.event_team_invite.body":
    "You've been invited to join the team for {{title}} as {{role}}. Open the event to accept or decline.",

  "role.cohost": "co-host",
  "role.coordinator": "coordinator",
  "role.staff": "staff",

  // Event-cancellation bell (L24, type 'cleanup_cancelled'): the host called the event off. Fanned out to
  // every OTHER member by cleanup-service.notifyCancellation. The reason is OPTIONAL on the wire, so there
  // are two bodies rather than one with an empty tail; {{reason}} is the host's own words (user content,
  // slur-gated by assertEventTextClean) and only the wrapper copy is translated.
  "notification.cleanup_cancelled.title": "Event cancelled",
  "notification.cleanup_cancelled.body": "This event has been cancelled by the host.",
  "notification.cleanup_cancelled.body_reason":
    "This event has been cancelled by the host. Reason: {{reason}}",

  // Service-hours credit bell (P4/B33, type 'hours_logged'): a host logged hours for a completed
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

  "notification.cleanup_slot.moved.title": "Your shift time changed",
  "notification.cleanup_slot.moved.body":
    'The "{{slot}}" shift at {{title}} has a new time. Open the event to check it.',

  // ---- Service-hours transcript / certificate (P5) ------------------------------------------------
  // Every chrome string the SERVER-RENDERED PDF prints (services/certificate-pdf.ts). This is an
  // official document a volunteer hands to a school, an employer or a court, so the register is plain
  // and the attestation paragraph states ONLY what the shipped crediting rules actually enforce
  // (volunteer-hours-service.ts: organizer/cohost gate, self-credit block). Do
  // not soften or embellish it — an untrue attestation on an official document is the worst failure mode
  // this feature has.
  //
  // 0065 RETIRED THE REPORT AUTO-AWARD, so the attestation no longer claims one: `logEventHours` is the
  // ONLY writer of credited hours, and a sentence saying the platform auto-awards report-verification
  // hours would now be false on the face of the document. Do not reinstate it.
  // test/unit/adapters-i18n-messages.test.ts pins that absence in all four locales.
  //
  // Dates print in America/Los_Angeles (CERTIFICATE_TIME_ZONE, a code constant, not an env var), which
  // is exactly what certificate.footer.timezone states on page 1.
  "certificate.doc.title": "Record of Volunteer Service",
  // PDF /Title in the Info dictionary. {{name}} = holder, {{code}} = the CFX-XXXX-XXXX-XXXX display code.
  "certificate.doc.pdf_title": "civfix service hours — {{name}} — {{code}}",
  "certificate.header.number": "Certificate No.",
  "certificate.holder.eyebrow": "Issued to",
  "certificate.holder.period": "Period of service",
  "certificate.holder.issued": "Issued",
  "certificate.summary.total_hours": "Total hours",
  "certificate.summary.activities": "Activities",
  "certificate.summary.communities": "Communities",
  "certificate.summary.more": "+{{count}} more",
  "certificate.table.date": "Date",
  "certificate.table.activity": "Activity",
  "certificate.table.community": "Community",
  "certificate.table.hours": "Hours",
  "certificate.table.credited_by": "Credited by",
  "certificate.table.total": "Total",
  // Above MAX_CERTIFICATE_ENTRIES the transcript STILL issues — refusing the most prolific volunteers
  // would be the wrong failure. B40b: the printed total is the sum of the PRINTED LINES, so this banner
  // says so plainly instead of claiming the total covers rows the document does not itemise.
  "certificate.table.truncated":
    "Showing the {{shown}} most recent of {{total}} activities. The total above is the sum of the {{shown}} listed.",
  // Report credits are awarded by the PLATFORM, never by a person: naming someone would be a fabricated
  // attestation.
  "certificate.credited_by.automatic": "Automatic (report verified)",
  // The report itself is never named or linked — a transcript is handed to strangers and reports can be
  // held, unlisted or sensitive. {{ref}} is the already-public reference code, and may be empty.
  "certificate.activity.report": "Verified report {{ref}}",
  "certificate.activity.manual": "Adjustment",
  "certificate.attestation.body":
    "This record was generated by civfix from its volunteer-service ledger. Hours for an event are entered by that event's host, who holds the event-management role on it and who cannot credit hours to themselves. The authoritative record is the one held by civfix; confirm this document at the address below.",
  "certificate.seal.line": "Verified record",
  "certificate.issuer.line": "Issued by civfix · civfix.org",
  "certificate.issuer.generated": "Generated {{timestamp}}",
  "certificate.verify.prompt": "Verify this record at civfix.org/service-record",
  "certificate.verify.fingerprint": "Document fingerprint",
  "certificate.footer.page": "Page {{page}} of {{total}}",
  "certificate.footer.timezone": "Dates shown in Pacific Time (America/Los_Angeles).",
  // 409 body when the ledger is empty: we refuse to mint an empty official-looking document.
  "certificate.error.no_hours": "You have no recorded service hours yet.",

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

  // ---- Guest event RSVP (contract 0.38.0) --------------------------------------------------------
  // Sent to people who are NOT users, so there is no users.locale to key off: the guest service renders
  // these in "en". They are catalogued anyway so a future guest-locale field needs no code change.
  "email.guest_otp.subject": "Your code to RSVP for {{title}}",
  "email.guest_otp.body":
    "Your code to RSVP for {{title}} is {{code}}. It expires in {{minutes}} minutes. If you did not request it, you can ignore this email.",
  "email.guest_confirmed.subject": "You are on the list for {{title}}",
  "email.guest_confirmed.body":
    "You are signed up for {{title}}. Check in by name when you arrive; there is no ticket to print. Change your mind? Cancel your RSVP here: {{link}}",
  "email.guest_promoted.subject": "A place opened up for {{title}}",
  "email.guest_promoted.body":
    "A place opened up for {{title}} on {{when}}. You were on the waitlist and the host is holding a place for you. See the event and contact the host if you still want it: {{link}}",
  "email.guest_updated.subject": "{{title}} has new details",
  "email.guest_updated.body":
    "The details for {{title}} changed. It now starts at {{when}} at {{place}}. Use the cancel link in your confirmation message if you can no longer make it.",
  "email.guest_cancelled.subject": "{{title}} has been cancelled",
  "email.guest_cancelled.body":
    "{{title}} has been cancelled by the host. There is nothing you need to do.",
  "email.guest_cancelled.body_reason": "{{title}} has been cancelled by the host. Reason: {{reason}}",
  "sms.guest_otp.body":
    "{{code}} is your civfix code to RSVP for {{title}}. Msg&data rates may apply. Reply STOP to opt out.",
  "sms.guest_confirmed.body":
    "You are on the list for {{title}}. Cancel: {{link}} Reply STOP to opt out.",
  "sms.guest_updated.body": "{{title}} changed: now {{when}} at {{place}}. Reply STOP to opt out.",
  "sms.guest_cancelled.body": "{{title}} has been cancelled by the host. Reply STOP to opt out.",

} satisfies MessageCatalog

/** The exhaustive set of message keys, derived from the EN source so es/de/ko can be checked complete. */
export type MessageKey = keyof typeof en
