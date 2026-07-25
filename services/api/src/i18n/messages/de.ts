/**
 * German (de) catalog for server-generated, user-facing copy. Translated key-by-key from en.ts.
 * Preserves all {{interpolation}} placeholders exactly. "civfix", URLs, and @handles are not translated.
 * Tone: concise, natural app German (informal "du" register appropriate for a community platform).
 *
 * SCOPE: push/bell notification titles + bodies; account/OTP email subjects + bodies.
 * Falls back to English (via renderMessage) for any key not present here.
 */

import type { MessageKey } from "./en.js"

export const de: Partial<Record<MessageKey, string>> = {
  // ---- Push / in-app bell notifications --------------------------------------------------------
  "notification.follower.title": "Neuer Follower",
  "notification.follower.body": "{{name}} folgt dir jetzt.",

  "notification.comment.title": "Neuer Kommentar zu deinem Bericht",
  "notification.comment.body": "Jemand hat deinen Bericht kommentiert.",

  "notification.reply.title": "Neue Antwort auf deinen Kommentar",
  "notification.reply.body": "Jemand hat auf deinen Kommentar geantwortet.",

  "notification.report_mention.title": "Du wurdest erwähnt",
  "notification.report_mention.body": "Jemand hat dich in einer Berichtsdiskussion erwähnt.",

  "notification.post.like.title": "Neues Like",
  "notification.post.like.body": "{{name}} gefällt dein Beitrag.",
  "notification.post.repost.title": "Neuer Repost",
  "notification.post.repost.body": "{{name}} hat deinen Beitrag repostet.",
  "notification.post.reply.title": "Neue Antwort",
  "notification.post.reply.body": "{{name}} hat auf deinen Beitrag geantwortet.",
  "notification.post.quote.title": "Neues Zitat",
  "notification.post.quote.body": "{{name}} hat deinen Beitrag zitiert.",
  "notification.post.mention.title": "{{name}} hat dich erwähnt",
  "notification.post.mention.body": "{{name}} hat dich in einem Beitrag erwähnt.",

  "notification.chat_mention.title": "{{name}} hat dich erwähnt",
  "notification.chat_reply.title": "{{name}} hat dir geantwortet",

  "notification.dm.title": "{{name}}",
  "notification.dm.title_fallback": "Neue Nachricht",
  "notification.report_chat.title_fallback": "Neue Nachricht",
  "notification.group_chat.title_fallback": "Neue Nachricht",

  "notification.message.no_preview": "Hat dir eine Nachricht gesendet",

  "notification.cleanup_role.promoted.title": "Du bist jetzt Co-Host",
  "notification.cleanup_role.promoted.body": "Du bist jetzt Co-Host von {{title}}.",
  "notification.cleanup_role.demoted.title": "Co-Host-Rolle entfernt",
  "notification.cleanup_role.demoted.body": "Du bist nicht mehr Co-Host von {{title}}.",
  "notification.cleanup_role.removed.title": "Aus dem Event entfernt",
  "notification.cleanup_role.removed.body": "Du wurdest aus {{title}} entfernt.",

  "notification.cleanup_cancelled.title": "Event abgesagt",
  "notification.cleanup_cancelled.body": "Dieses Event wurde vom Host abgesagt.",
  "notification.cleanup_cancelled.body_reason":
    "Dieses Event wurde vom Host abgesagt. Grund: {{reason}}",

  // ---- Account / OTP emails --------------------------------------------------------------------
  "email.otp.subject": "Dein civfix-Anmeldecode",
  "email.otp.body_line1": "Dein civfix-Anmeldecode lautet {{code}}.",
  "email.otp.body_expiry":
    "Er läuft in 5 Minuten ab. Falls du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.",
  "email.otp.html_intro": "Dein civfix-Anmeldecode lautet:",

  "email.report_update.subject": "Dein civfix-Bericht wurde {{status}}",
  "email.report_update.body": "Dein Bericht hat einen neuen Status: {{status}}.",

  "email.generic.subject": "Eine civfix-Benachrichtigung",
  "email.generic.body": "Du hast eine neue civfix-Benachrichtigung.",
}
