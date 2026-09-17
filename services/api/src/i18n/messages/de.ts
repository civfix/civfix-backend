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

  "notification.event_team_invite.title": "Du wurdest eingeladen, ein Event mitzuorganisieren",
  "notification.event_team_invite.body":
    "Du wurdest eingeladen, dem Team von {{title}} als {{role}} beizutreten. Öffne das Event, um anzunehmen oder abzulehnen.",

  "role.cohost": "Co-Host",
  "role.coordinator": "Koordinator*in",
  "role.staff": "Teammitglied",

  "notification.cleanup_cancelled.title": "Event abgesagt",
  "notification.cleanup_cancelled.body": "Dieses Event wurde vom Host abgesagt.",
  "notification.cleanup_cancelled.body_reason":
    "Dieses Event wurde vom Host abgesagt. Grund: {{reason}}",

  "notification.hours_logged.title": "Ehrenamtsstunden gutgeschrieben",
  "notification.hours_logged.body": "Für {{title}} wurden dir {{hours}} Stunden gutgeschrieben.",

  "notification.cleanup_slot.removed.title": "Deine Rolle im Event hat sich geändert",
  "notification.cleanup_slot.removed.body": 'Die Rolle "{{slot}}" wurde aus {{title}} entfernt.',
  "notification.cleanup_slot.moved.title": "Deine Schichtzeit hat sich geändert",
  "notification.cleanup_slot.moved.body":
    'Die Schicht "{{slot}}" bei {{title}} hat eine neue Zeit. Öffne das Event, um sie zu prüfen.',

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
  // ---- Nachweis über ehrenamtliche Arbeit (PDF, P5) -----------------------------------------------
  "certificate.doc.title": "Nachweis über ehrenamtliche Arbeit",
  "certificate.doc.pdf_title": "civfix-Einsatzstunden — {{name}} — {{code}}",
  "certificate.header.number": "Zertifikatsnr.",
  "certificate.holder.eyebrow": "Ausgestellt für",
  "certificate.holder.period": "Einsatzzeitraum",
  "certificate.holder.issued": "Ausgestellt",
  "certificate.summary.total_hours": "Stunden gesamt",
  "certificate.summary.activities": "Aktivitäten",
  "certificate.summary.communities": "Gemeinden",
  "certificate.summary.more": "+{{count}} weitere",
  "certificate.table.date": "Datum",
  "certificate.table.activity": "Aktivität",
  "certificate.table.community": "Gemeinde",
  "certificate.table.hours": "Stunden",
  "certificate.table.credited_by": "Gutgeschrieben von",
  "certificate.table.total": "Gesamt",
  "certificate.table.truncated":
    "Angezeigt werden die {{shown}} neuesten von {{total}} Aktivitäten. Die Summe oben ist die Summe der {{shown}} aufgeführten.",
  "certificate.credited_by.automatic": "Automatisch (Meldung verifiziert)",
  "certificate.activity.report": "Verifizierte Meldung {{ref}}",
  "certificate.activity.manual": "Korrektur",
  "certificate.attestation.body":
    "Dieser Nachweis wurde von civfix aus dem Einsatzstunden-Register erstellt. Die Stunden für eine Veranstaltung trägt deren gastgebende Person ein, die für diese Veranstaltung die Verwaltungsrolle innehat und sich selbst keine Stunden gutschreiben kann. Maßgeblich ist der bei civfix geführte Datensatz; bestätige dieses Dokument unter der unten genannten Adresse.",
  "certificate.seal.line": "Verifizierter Nachweis",
  "certificate.issuer.line": "Ausgestellt von civfix · civfix.org",
  "certificate.issuer.generated": "Erstellt {{timestamp}}",
  "certificate.verify.prompt": "Diesen Nachweis auf civfix.org/service-record prüfen",
  "certificate.verify.fingerprint": "Dokument-Fingerabdruck",
  "certificate.footer.page": "Seite {{page}} von {{total}}",
  "certificate.footer.timezone": "Datumsangaben in Pazifikzeit (America/Los_Angeles).",
  "certificate.error.no_hours": "Du hast noch keine erfassten Einsatzstunden.",

  // ---- Guest event RSVP -------------------------------------------------------------------------
  "email.guest_otp.subject": "Dein Code für die Anmeldung zu {{title}}",
  "email.guest_otp.body":
    "Dein Code für die Anmeldung zu {{title}} lautet {{code}}. Er läuft in {{minutes}} Minuten ab. Wenn du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.",
  "email.guest_confirmed.subject": "Du stehst auf der Liste für {{title}}",
  "email.guest_confirmed.body":
    "Du bist für {{title}} angemeldet. Melde dich vor Ort mit deinem Namen an; es gibt kein Ticket zum Ausdrucken. Anders entschieden? Hier kannst du deine Anmeldung stornieren: {{link}}",
  "email.guest_promoted.subject": "Ein Platz für {{title}} ist frei geworden",
  "email.guest_promoted.body":
    "Ein Platz für {{title}} am {{when}} ist frei geworden. Du standest auf der Warteliste, und die Veranstalterin oder der Veranstalter hält einen Platz für dich frei. Sieh dir die Veranstaltung an und melde dich dort, wenn du noch kommen möchtest: {{link}}",
  "email.guest_updated.subject": "{{title}} hat neue Angaben",
  "email.guest_updated.body":
    "Die Angaben zu {{title}} haben sich geändert. Es beginnt jetzt um {{when}} an folgendem Ort: {{place}}. Nutze den Stornierungslink aus deiner Bestätigung, falls du nicht mehr kommen kannst.",
  "email.guest_cancelled.subject": "{{title}} wurde abgesagt",
  "email.guest_cancelled.body":
    "{{title}} wurde von der Veranstalterin oder dem Veranstalter abgesagt. Du musst nichts weiter tun.",
  "email.guest_cancelled.body_reason":
    "{{title}} wurde von der Veranstalterin oder dem Veranstalter abgesagt. Grund: {{reason}}",
  "sms.guest_otp.body":
    "{{code}} ist dein civfix-Code für die Anmeldung zu {{title}}. Es können Nachrichten- und Datengebühren anfallen. Antworte mit STOP, um dich abzumelden.",
  "sms.guest_confirmed.body":
    "Du stehst auf der Liste für {{title}}. Stornieren: {{link}} Antworte mit STOP, um dich abzumelden.",
  "sms.guest_updated.body":
    "{{title}} geändert: jetzt {{when}} an folgendem Ort: {{place}}. Antworte mit STOP, um dich abzumelden.",
  "sms.guest_cancelled.body":
    "{{title}} wurde von der Veranstalterin oder dem Veranstalter abgesagt. Antworte mit STOP, um dich abzumelden.",

}
