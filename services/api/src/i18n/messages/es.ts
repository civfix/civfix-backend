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

  "notification.post.like.title": "Nuevo me gusta",
  "notification.post.like.body": "A {{name}} le gustó tu publicación.",
  "notification.post.repost.title": "Nueva republicación",
  "notification.post.repost.body": "{{name}} republicó tu publicación.",
  "notification.post.reply.title": "Nueva respuesta",
  "notification.post.reply.body": "{{name}} respondió a tu publicación.",
  "notification.post.quote.title": "Nueva cita",
  "notification.post.quote.body": "{{name}} citó tu publicación.",
  "notification.post.mention.title": "{{name}} te mencionó",
  "notification.post.mention.body": "{{name}} te mencionó en una publicación.",

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

  "notification.cleanup_cancelled.title": "Evento cancelado",
  "notification.cleanup_cancelled.body": "Este evento ha sido cancelado por el anfitrión.",
  "notification.cleanup_cancelled.body_reason":
    "Este evento ha sido cancelado por el anfitrión. Motivo: {{reason}}",

  "notification.hours_logged.title": "Horas de servicio acreditadas",
  "notification.hours_logged.body": "Se acreditaron {{hours}} horas por {{title}}.",

  "notification.cleanup_slot.removed.title": "Tu rol en el evento cambió",
  "notification.cleanup_slot.removed.body": 'Se eliminó el rol "{{slot}}" de {{title}}.',

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
  // ---- Registro de servicio voluntario (PDF, P5) --------------------------------------------------
  "certificate.doc.title": "Registro de servicio voluntario",
  "certificate.doc.pdf_title": "horas de servicio civfix — {{name}} — {{code}}",
  "certificate.header.number": "Certificado n.º",
  "certificate.holder.eyebrow": "Emitido a",
  "certificate.holder.verified": "Miembro de la comunidad con identidad verificada",
  "certificate.holder.period": "Periodo de servicio",
  "certificate.holder.issued": "Emitido",
  "certificate.summary.total_hours": "Horas totales",
  "certificate.summary.activities": "Actividades",
  "certificate.summary.communities": "Comunidades",
  "certificate.summary.more": "+{{count}} más",
  "certificate.table.date": "Fecha",
  "certificate.table.activity": "Actividad",
  "certificate.table.community": "Comunidad",
  "certificate.table.hours": "Horas",
  "certificate.table.credited_by": "Acreditado por",
  "certificate.table.total": "Total",
  "certificate.table.truncated":
    "Se muestran las {{shown}} actividades más recientes de {{total}}. El total anterior es la suma de las {{shown}} listadas.",
  "certificate.credited_by.automatic": "Automático (reporte verificado)",
  "certificate.activity.report": "Reporte verificado {{ref}}",
  "certificate.activity.manual": "Ajuste",
  "certificate.attestation.body":
    "Este registro fue generado por civfix a partir de su libro de servicio voluntario. Las horas de un evento las registra la persona anfitriona de ese evento, que debe ser una organizadora con identidad verificada y no puede acreditarse horas a sí misma. El registro autoritativo es el que conserva civfix; confirma este documento en la dirección indicada abajo.",
  "certificate.seal.line": "Registro verificado",
  "certificate.issuer.line": "Emitido por civfix · civfix.org",
  "certificate.issuer.generated": "Generado {{timestamp}}",
  "certificate.verify.prompt": "Verifica este registro en civfix.org/service-record",
  "certificate.verify.fingerprint": "Huella del documento",
  "certificate.footer.page": "Página {{page}} de {{total}}",
  "certificate.footer.timezone": "Las fechas se muestran en hora del Pacífico (America/Los_Angeles).",
  "certificate.error.no_hours": "Todavía no tienes horas de servicio registradas.",

  // ---- Guest event RSVP -------------------------------------------------------------------------
  "email.guest_otp.subject": "Tu código para confirmar tu asistencia a {{title}}",
  "email.guest_otp.body":
    "Tu código para confirmar tu asistencia a {{title}} es {{code}}. Caduca en {{minutes}} minutos. Si no lo solicitaste, puedes ignorar este correo.",
  "email.guest_confirmed.subject": "Estás en la lista de {{title}}",
  "email.guest_confirmed.body":
    "Te has apuntado a {{title}}. ¿Cambiaste de opinión? Cancela tu asistencia aquí: {{link}}",
  "email.guest_updated.subject": "{{title}} tiene nuevos detalles",
  "email.guest_updated.body":
    "Los detalles de {{title}} han cambiado. Ahora empieza a las {{when}} en {{place}}. Usa el enlace de cancelación de tu mensaje de confirmación si ya no puedes asistir.",
  "email.guest_cancelled.subject": "{{title}} ha sido cancelado",
  "email.guest_cancelled.body": "El organizador ha cancelado {{title}}. No tienes que hacer nada.",
  "email.guest_cancelled.body_reason": "El organizador ha cancelado {{title}}. Motivo: {{reason}}",
  "sms.guest_otp.body":
    "{{code}} es tu código de civfix para confirmar tu asistencia a {{title}}. Pueden aplicarse tarifas de mensajes y datos. Responde STOP para darte de baja.",
  "sms.guest_confirmed.body":
    "Estás en la lista de {{title}}. Responde STOP para darte de baja, o usa el enlace de tu confirmación para cancelar.",
  "sms.guest_updated.body":
    "{{title}} ha cambiado: ahora {{when}} en {{place}}. Responde STOP para darte de baja.",
  "sms.guest_cancelled.body": "El organizador ha cancelado {{title}}. Responde STOP para darte de baja.",

}
