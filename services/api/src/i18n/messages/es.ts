/**
 * Spanish (es) catalog for server-generated, user-facing copy. Translated key-by-key from en.ts.
 * Preserves all {{interpolation}} placeholders exactly. "civfix", URLs, and @handles are not translated.
 *
 * SCOPE: push/bell notification titles + bodies; account/OTP email subjects + bodies.
 * Falls back to English (via renderMessage) for any key not present here.
 */

import type { MessageKey } from "./en.js"

export const es: Partial<Record<MessageKey, string>> = {
  // ---- Push / in-app bell notifications --------------------------------------------------------
  "notification.follower.title": "Nuevo seguidor",
  "notification.follower.body": "{{name}} ha empezado a seguirte.",

  "notification.comment.title": "Nuevo comentario en tu reporte",
  "notification.comment.body": "Alguien comentó en tu reporte.",

  "notification.reply.title": "Nueva respuesta a tu comentario",
  "notification.reply.body": "Alguien respondió a tu comentario.",

  "notification.report_mention.title": "Te mencionaron",
  "notification.report_mention.body": "Alguien te mencionó en una discusión de reporte.",

  "notification.chat_mention.title": "{{name}} te mencionó",
  "notification.chat_reply.title": "{{name}} te respondió",

  "notification.dm.title": "{{name}}",
  "notification.dm.title_fallback": "Nuevo mensaje",
  "notification.report_chat.title_fallback": "Nuevo mensaje",
  "notification.group_chat.title_fallback": "Nuevo mensaje",

  "notification.message.no_preview": "Te envió un mensaje",

  "notification.cleanup_role.promoted.title": "Ahora eres coanfitrión",
  "notification.cleanup_role.promoted.body": "Ahora eres coanfitrión de {{title}}.",
  "notification.cleanup_role.demoted.title": "Rol de coanfitrión retirado",
  "notification.cleanup_role.demoted.body": "Ya no eres coanfitrión de {{title}}.",
  "notification.cleanup_role.removed.title": "Eliminado del evento",
  "notification.cleanup_role.removed.body": "Se te eliminó de {{title}}.",

  // ---- Account / OTP emails --------------------------------------------------------------------
  "email.otp.subject": "Tu código de acceso a civfix",
  "email.otp.body_line1": "Tu código de acceso a civfix es {{code}}.",
  "email.otp.body_expiry":
    "Caduca en 5 minutos. Si no lo solicitaste, puedes ignorar este correo.",
  "email.otp.html_intro": "Tu código de acceso a civfix es:",

  "email.report_update.subject": "Tu reporte en civfix fue {{status}}",
  "email.report_update.body": "Tu reporte tiene un nuevo estado: {{status}}.",

  "email.generic.subject": "Una notificación de civfix",
  "email.generic.body": "Tienes una nueva notificación de civfix.",
}
