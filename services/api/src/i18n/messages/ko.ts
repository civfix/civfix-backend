/**
 * Korean (ko) catalog for server-generated, user-facing copy. Translated key-by-key from en.ts.
 * Preserves all {{interpolation}} placeholders exactly. "civfix", URLs, and @handles are not translated.
 * Tone: natural, friendly Hangul appropriate for a community app (informal-polite 해요체 register).
 *
 * SCOPE: push/bell notification titles + bodies; account/OTP email subjects + bodies.
 * Falls back to English (via renderMessage) for any key not present here.
 */

import type { MessageKey } from "./en.js"

export const ko: Partial<Record<MessageKey, string>> = {
  // ---- Push / in-app bell notifications --------------------------------------------------------
  "notification.follower.title": "새 팔로워",
  "notification.follower.body": "{{name}}님이 팔로우하기 시작했어요.",

  "notification.comment.title": "내 제보에 새 댓글",
  "notification.comment.body": "누군가 내 제보에 댓글을 달았어요.",

  "notification.reply.title": "내 댓글에 새 답글",
  "notification.reply.body": "누군가 내 댓글에 답글을 달았어요.",

  "notification.report_mention.title": "회원님이 언급되었어요",
  "notification.report_mention.body": "누군가 제보 토론에서 회원님을 언급했어요.",

  "notification.chat_mention.title": "{{name}}님이 회원님을 언급했어요",

  "notification.dm.title": "{{name}}",
  "notification.dm.title_fallback": "새 메시지",

  "notification.message.no_preview": "메시지를 보냈어요",

  // ---- Account / OTP emails --------------------------------------------------------------------
  "email.otp.subject": "civfix 로그인 코드",
  "email.otp.body_line1": "civfix 로그인 코드는 {{code}}입니다.",
  "email.otp.body_expiry":
    "코드는 5분 후 만료됩니다. 요청하지 않으셨다면 이 이메일을 무시하세요.",
  "email.otp.html_intro": "civfix 로그인 코드:",

  "email.report_update.subject": "civfix 제보가 {{status}} 처리되었어요",
  "email.report_update.body": "제보 상태가 변경되었어요: {{status}}.",

  "email.generic.subject": "civfix 알림",
  "email.generic.body": "새로운 civfix 알림이 있어요.",
}
