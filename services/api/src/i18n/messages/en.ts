/**
 * Source catalog for server-generated, user-facing copy; es/de/ko are translated key-by-key and fall back
 * here for any missing key.
 *
 * Excluded: jurisdiction report-packet emails (mail-format.ts) stay English because the recipients are
 * officials, and validation errors travel as stable error CODES that clients localize.
 *
 * User-authored content echoed into a notification (a DM/mention preview) arrives as a `{{preview}}` var,
 * truncated by the caller; only the wrapper copy is translated.
 */

export type MessageCatalog = Record<string, string>

export const en = {
  // {{name}} = follower @handle/display name.
  "notification.follower.title": "New follower",
  "notification.follower.body": "{{name}} started following you.",

  "notification.comment.title": "New comment on your report",
  "notification.comment.body": "Someone commented on your report.",

  "notification.reply.title": "New reply on your comment",
  "notification.reply.body": "Someone replied to your comment.",

  "notification.report_mention.title": "You were mentioned",
  "notification.report_mention.body": "Someone mentioned you in a report discussion.",

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

  // {{name}} = author handle/name.
  "notification.chat_mention.title": "{{name}} mentioned you",
  // The one chat bell that pierces conversation mutes. {{name}} = author handle/name.
  "notification.chat_reply.title": "{{name}} replied to you",
  // {{name}} = sender handle/name.
  "notification.dm.title": "{{name}}",
  "notification.dm.title_fallback": "New message",
  // For a system / author-less report message (a status or timeline event) with no sender name to show.
  "notification.report_chat.title_fallback": "New message",
  "notification.group_chat.title_fallback": "New message",
  // For a non-text frame (share_pin / rsvp / task_complete) that has no text preview.
  "notification.message.no_preview": "Sent you a message",

  // {{title}} = the event title.
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

  // The reason is optional on the wire, so there are two bodies rather than one with an empty tail.
  // {{reason}} is the host's own words (user content, slur-gated by assertEventTextClean).
  "notification.cleanup_cancelled.title": "Event cancelled",
  "notification.cleanup_cancelled.body": "This event has been cancelled by the host.",
  "notification.cleanup_cancelled.body_reason":
    "This event has been cancelled by the host. Reason: {{reason}}",

  // Sent only when a credit is new or has increased: re-logging is how a host fixes a typo, and a
  // downward correction is deliberately silent. {{hours}} = the credited amount, {{title}} = the event.
  "notification.hours_logged.title": "Service hours credited",
  "notification.hours_logged.body": "{{hours}} hours were credited for {{title}}.",

  // The host edited the event's roles and the one you had claimed no longer exists, so you are back in
  // the crew with no role. {{slot}} = the removed role's title, {{title}} = the event. There is
  // deliberately no "slot claimed" bell to the host.
  "notification.cleanup_slot.removed.title": "Your event role changed",
  "notification.cleanup_slot.removed.body": 'The "{{slot}}" role was removed from {{title}}.',

  "notification.cleanup_slot.moved.title": "Your shift time changed",
  "notification.cleanup_slot.moved.body":
    'The "{{slot}}" shift at {{title}} has a new time. Open the event to check it.',

  // Chrome for the server-rendered certificate PDF (services/certificate-pdf.ts). It is an official
  // document a volunteer hands to a school, an employer or a court, so the attestation states ONLY what
  // the crediting rules in volunteer-hours-service.ts enforce (organizer/cohost gate, self-credit block).
  // An untrue attestation is the worst failure mode this feature has: do not soften or embellish it.
  //
  // Migration 0065 retired the report auto-award, so `logEventHours` is the only writer of credited hours
  // and the attestation must not claim an auto-award. test/unit/adapters-i18n-messages.test.ts pins that
  // absence in all four locales.
  //
  // Dates print in America/Los_Angeles (CERTIFICATE_TIME_ZONE, a code constant), which is what
  // certificate.footer.timezone states.
  "certificate.doc.title": "Record of Volunteer Service",
  // PDF /Title in the Info dictionary. {{code}} = the CFX-XXXX-XXXX-XXXX display code.
  "certificate.doc.pdf_title": "civfix service hours: {{name}}, {{code}}",
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
  // Above MAX_CERTIFICATE_ENTRIES the transcript still issues (refusing the most prolific volunteers would
  // be the wrong failure). The printed total is the sum of the printed lines, so this says so instead of
  // claiming the total covers rows the document does not itemise.
  "certificate.table.truncated":
    "Showing the {{shown}} most recent of {{total}} activities. The total above is the sum of the {{shown}} listed.",
  // Report credits are awarded by the PLATFORM, never by a person: naming someone would be a fabricated
  // attestation.
  "certificate.credited_by.automatic": "Automatic (report verified)",
  // The report itself is never named or linked: a transcript is handed to strangers and reports can be
  // held, unlisted or sensitive. {{ref}} is the already-public reference code, and may be empty.
  "certificate.activity.report": "Verified report {{ref}}",
  "certificate.activity.manual": "Adjustment",
  "certificate.attestation.body":
    "This record was generated by civfix from its volunteer-service ledger. Hours for an event are entered by that event's host, who holds the event-management role on it and who cannot credit hours to themselves. The authoritative record is the one held by civfix; confirm this document at the address below.",
  "certificate.seal.line": "Verified record",
  "certificate.issuer.line": "Issued by civfix · civfix.org",
  "certificate.issuer.generated": "Generated {{timestamp}}",
  // {{url}} = the deployment's verify page without its scheme, so a staging PDF never sends a reader to
  // production to check it.
  "certificate.verify.prompt": "Verify this record at {{url}}",
  "certificate.verify.fingerprint": "Document fingerprint",
  "certificate.footer.page": "Page {{page}} of {{total}}",
  "certificate.footer.timezone": "Dates shown in Pacific Time (America/Los_Angeles).",
  // The ledger is empty: we refuse to mint an empty official-looking document.
  "certificate.error.no_hours": "You have no recorded service hours yet.",

  "email.otp.subject": "Your civfix sign-in code",
  "email.otp.body_expiry":
    "It expires in {{minutes}} minutes. If you did not request it, you can ignore this email.",
  // The code itself is rendered in a styled block by the template.
  "email.otp.html_intro": "Your civfix sign-in code is:",

  // {{status}} = localized/raw status label.
  "email.report_update.subject": "Your civfix report was {{status}}",
  "email.report_update.body": "Your report has a new status: {{status}}.",

  // Fallback for an unknown template.
  "email.generic.subject": "A civfix notification",
  "email.generic.body": "You have a new civfix notification.",

  // Guest RSVP messages go to people who are NOT users, so there is no users.locale to key off: the guest service renders
  // these in "en". They are catalogued anyway so a future guest-locale field needs no code change.
  "email.guest_otp.subject": "Your code to RSVP for {{title}}",
  "email.guest_otp.html_intro": "Your code to RSVP for {{title}} is:",
  "email.guest_otp.body_expiry":
    "It expires in {{minutes}} minutes. If you did not request it, you can ignore this email.",
  "email.guest_confirmed.subject": "You are on the list for {{title}}",
  "email.guest_confirmed.checkin":
    "You are on the list. Check in by name when you arrive; there is no ticket to print.",
  "email.guest_confirmed.cancel_hint":
    "Plans changed? Cancel your RSVP so someone else can take the place.",
  "email.guest_confirmed.cancel_cta": "Cancel RSVP",
  "email.event.when": "When",
  "email.event.where": "Where",
  "email.guest_promoted.subject": "A place opened up for {{title}}",
  "email.guest_promoted.intro":
    "A place opened up for {{title}} on {{when}}. You were on the waitlist and the host is holding a place for you.",
  "email.guest_promoted.cta": "See the event",
  "email.guest_promoted.ignore":
    "If you no longer want the place, there is nothing you need to do.",
  "email.guest_updated.subject": "{{title}} has new details",
  "email.guest_updated.body":
    "The details for {{title}} changed. It now starts at {{when}} at {{place}}. Use the cancel link in your confirmation message if you can no longer make it.",
  "email.guest_cancelled.subject": "{{title}} has been cancelled",
  "email.guest_cancelled.body":
    "{{title}} has been cancelled by the host. There is nothing you need to do.",
  "email.guest_cancelled.body_reason":
    "{{title}} has been cancelled by the host. Reason: {{reason}}",
  "sms.guest_otp.body":
    "{{code}} is your civfix code to RSVP for {{title}}. Msg&data rates may apply. Reply STOP to opt out.",
  "sms.guest_confirmed.body":
    "You are on the list for {{title}}. Cancel: {{link}} Reply STOP to opt out.",
  "sms.guest_updated.body": "{{title}} changed: now {{when}} at {{place}}. Reply STOP to opt out.",
  "sms.guest_cancelled.body": "{{title}} has been cancelled by the host. Reply STOP to opt out.",
} satisfies MessageCatalog

/** Derived from the EN source so es/de/ko can be checked complete. */
export type MessageKey = keyof typeof en
