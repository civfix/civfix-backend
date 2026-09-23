/**
 * Spanish (es) catalog for server-generated, user-facing copy. Translated key-by-key from en.ts.
 * Preserves all {{interpolation}} placeholders exactly. "civfix", URLs, and @handles are not translated.
 * Missing keys fall back to English in renderMessage.
 */

import type { MessageKey } from "./en.js"

export const es: Partial<Record<MessageKey, string>> = {
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

  "notification.event_team_invite.title": "Te han invitado a ayudar con un evento",
  "notification.event_team_invite.body":
    "Te han invitado a unirte al equipo de {{title}} como {{role}}. Abre el evento para aceptar o rechazar.",

  "role.cohost": "coanfitrión",
  "role.coordinator": "coordinador",
  "role.staff": "personal de apoyo",

  "notification.cleanup_cancelled.title": "Evento cancelado",
  "notification.cleanup_cancelled.body": "Este evento ha sido cancelado por el anfitrión.",
  "notification.cleanup_cancelled.body_reason":
    "Este evento ha sido cancelado por el anfitrión. Motivo: {{reason}}",

  "notification.hours_logged.title": "Horas de servicio acreditadas",
  "notification.hours_logged.body": "Se acreditaron {{hours}} horas por {{title}}.",

  "notification.cleanup_slot.removed.title": "Tu rol en el evento cambió",
  "notification.cleanup_slot.removed.body": 'Se eliminó el rol "{{slot}}" de {{title}}.',
  "notification.cleanup_slot.moved.title": "El horario de tu turno cambió",
  "notification.cleanup_slot.moved.body":
    'El turno "{{slot}}" de {{title}} tiene un horario nuevo. Abre el evento para verlo.',

  "email.otp.subject": "Tu código de acceso a civfix",
  "email.otp.body_line1": "Tu código de acceso a civfix es {{code}}.",
  "email.otp.body_expiry":
    "Caduca en {{minutes}} minutos. Si no lo solicitaste, puedes ignorar este correo.",
  "email.otp.html_intro": "Tu código de acceso a civfix es:",

  "email.report_update.subject": "Tu reporte en civfix fue {{status}}",
  "email.report_update.body": "Tu reporte tiene un nuevo estado: {{status}}.",

  "email.generic.subject": "Una notificación de civfix",
  "email.generic.body": "Tienes una nueva notificación de civfix.",
  "certificate.doc.title": "Registro de servicio voluntario",
  "certificate.doc.pdf_title": "horas de servicio civfix — {{name}} — {{code}}",
  "certificate.header.number": "Certificado n.º",
  "certificate.holder.eyebrow": "Emitido a",
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
    "Este registro fue generado por civfix a partir de su libro de servicio voluntario. Las horas de un evento las registra la persona anfitriona de ese evento, que debe tener el rol de gestión de ese evento y no puede acreditarse horas a sí misma. El registro autoritativo es el que conserva civfix; confirma este documento en la dirección indicada abajo.",
  "certificate.seal.line": "Registro verificado",
  "certificate.issuer.line": "Emitido por civfix · civfix.org",
  "certificate.issuer.generated": "Generado {{timestamp}}",
  "certificate.verify.prompt": "Verifica este registro en {{url}}",
  "certificate.verify.fingerprint": "Huella del documento",
  "certificate.footer.page": "Página {{page}} de {{total}}",
  "certificate.footer.timezone":
    "Las fechas se muestran en hora del Pacífico (America/Los_Angeles).",
  "certificate.error.no_hours": "Todavía no tienes horas de servicio registradas.",

  "email.guest_otp.subject": "Tu código para confirmar tu asistencia a {{title}}",
  "email.guest_otp.html_intro": "Tu código para confirmar tu asistencia a {{title}} es:",
  "email.guest_otp.body_expiry":
    "Caduca en {{minutes}} minutos. Si no lo solicitaste, puedes ignorar este correo.",
  "email.guest_confirmed.subject": "Estás en la lista de {{title}}",
  "email.guest_confirmed.checkin":
    "Estás en la lista. Al llegar, regístrate con tu nombre; no hay ninguna entrada que imprimir.",
  "email.guest_confirmed.cancel_hint":
    "¿Cambiaron tus planes? Cancela tu asistencia para que otra persona pueda ocupar la plaza.",
  "email.guest_confirmed.cancel_cta": "Cancelar asistencia",
  "email.event.when": "Cuándo",
  "email.event.where": "Dónde",
  "email.guest_promoted.subject": "Se ha liberado una plaza para {{title}}",
  "email.guest_promoted.intro":
    "Se ha liberado una plaza para {{title}} el {{when}}. Estabas en la lista de espera y la organización te está reservando una plaza.",
  "email.guest_promoted.cta": "Ver el evento",
  "email.guest_promoted.ignore": "Si ya no quieres la plaza, no tienes que hacer nada.",
  "email.guest_updated.subject": "{{title}} tiene nuevos detalles",
  "email.guest_updated.body":
    "Los detalles de {{title}} han cambiado. Ahora empieza a las {{when}} en {{place}}. Usa el enlace de cancelación de tu mensaje de confirmación si ya no puedes asistir.",
  "email.guest_cancelled.subject": "{{title}} ha sido cancelado",
  "email.guest_cancelled.body": "El organizador ha cancelado {{title}}. No tienes que hacer nada.",
  "email.guest_cancelled.body_reason": "El organizador ha cancelado {{title}}. Motivo: {{reason}}",
  "sms.guest_otp.body":
    "{{code}} es tu código de civfix para confirmar tu asistencia a {{title}}. Pueden aplicarse tarifas de mensajes y datos. Responde STOP para darte de baja.",
  "sms.guest_confirmed.body":
    "Estás en la lista de {{title}}. Cancelar: {{link}} Responde STOP para darte de baja.",
  "sms.guest_updated.body":
    "{{title}} ha cambiado: ahora {{when}} en {{place}}. Responde STOP para darte de baja.",
  "sms.guest_cancelled.body":
    "El organizador ha cancelado {{title}}. Responde STOP para darte de baja.",
}
