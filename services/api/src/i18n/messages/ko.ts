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

  "notification.post.like.title": "새 좋아요",
  "notification.post.like.body": "{{name}}님이 회원님의 게시물을 좋아합니다.",
  "notification.post.repost.title": "새 리포스트",
  "notification.post.repost.body": "{{name}}님이 회원님의 게시물을 리포스트했어요.",
  "notification.post.reply.title": "새 답글",
  "notification.post.reply.body": "{{name}}님이 회원님의 게시물에 답글을 달았어요.",
  "notification.post.quote.title": "새 인용",
  "notification.post.quote.body": "{{name}}님이 회원님의 게시물을 인용했어요.",
  "notification.post.mention.title": "{{name}}님이 회원님을 언급했어요",
  "notification.post.mention.body": "{{name}}님이 게시물에서 회원님을 언급했어요.",

  "notification.chat_mention.title": "{{name}}님이 회원님을 언급했어요",
  "notification.chat_reply.title": "{{name}}님이 회원님에게 답장했어요",

  "notification.dm.title": "{{name}}",
  "notification.dm.title_fallback": "새 메시지",
  "notification.report_chat.title_fallback": "새 메시지",
  "notification.group_chat.title_fallback": "새 메시지",

  "notification.message.no_preview": "메시지를 보냈어요",

  "notification.cleanup_role.promoted.title": "이제 공동 주최자입니다",
  "notification.cleanup_role.promoted.body": "{{title}}의 공동 주최자가 되었어요.",
  "notification.cleanup_role.demoted.title": "공동 주최자 역할 해제",
  "notification.cleanup_role.demoted.body": "더 이상 {{title}}의 공동 주최자가 아니에요.",
  "notification.cleanup_role.removed.title": "이벤트에서 제외됨",
  "notification.cleanup_role.removed.body": "{{title}}에서 제외되었어요.",

  "notification.event_team_invite.title": "이벤트 운영 팀에 초대되었습니다",
  "notification.event_team_invite.body":
    "{{title}}의 운영 팀에 {{role}} 역할로 초대되었어요. 이벤트를 열어 수락하거나 거절해 주세요.",

  "role.cohost": "공동 주최자",
  "role.coordinator": "코디네이터",
  "role.staff": "스태프",

  "notification.cleanup_cancelled.title": "이벤트 취소됨",
  "notification.cleanup_cancelled.body": "주최자가 이 이벤트를 취소했어요.",
  "notification.cleanup_cancelled.body_reason": "주최자가 이 이벤트를 취소했어요. 사유: {{reason}}",

  "notification.hours_logged.title": "봉사 시간이 인정되었어요",
  "notification.hours_logged.body": "{{title}} 활동으로 {{hours}}시간이 인정되었어요.",

  "notification.cleanup_slot.removed.title": "이벤트 역할이 변경되었어요",
  "notification.cleanup_slot.removed.body": '{{title}}에서 "{{slot}}" 역할이 삭제되었어요.',
  "notification.cleanup_slot.moved.title": "교대 시간이 변경되었어요",
  "notification.cleanup_slot.moved.body":
    '{{title}}의 "{{slot}}" 교대 시간이 바뀌었어요. 이벤트를 열어 확인해 주세요.',

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
  // ---- 자원봉사 활동 증명서 (PDF, P5) --------------------------------------------------------------
  "certificate.doc.title": "자원봉사 활동 증명서",
  "certificate.doc.pdf_title": "civfix 봉사 시간 — {{name}} — {{code}}",
  "certificate.header.number": "증명서 번호",
  "certificate.holder.eyebrow": "발급 대상",
  "certificate.holder.period": "봉사 기간",
  "certificate.holder.issued": "발급일",
  "certificate.summary.total_hours": "총 시간",
  "certificate.summary.activities": "활동 수",
  "certificate.summary.communities": "지역",
  "certificate.summary.more": "외 {{count}}곳",
  "certificate.table.date": "날짜",
  "certificate.table.activity": "활동",
  "certificate.table.community": "지역",
  "certificate.table.hours": "시간",
  "certificate.table.credited_by": "인정한 사람",
  "certificate.table.total": "합계",
  "certificate.table.truncated":
    "전체 {{total}}건의 활동 중 최근 {{shown}}건을 표시했어요. 위 합계는 표시된 {{shown}}건의 합이에요.",
  "certificate.credited_by.automatic": "자동 (제보 확인)",
  "certificate.activity.report": "확인된 제보 {{ref}}",
  "certificate.activity.manual": "조정",
  "certificate.attestation.body":
    "이 증명서는 civfix의 자원봉사 시간 기록에서 생성되었어요. 행사 시간은 해당 행사의 주최자가 입력하며, 주최자는 해당 행사의 관리 권한을 가진 사람이어야 하고 자신에게 시간을 인정할 수 없어요. 공식 기록은 civfix가 보관하는 기록이며, 아래 주소에서 이 문서를 확인할 수 있어요.",
  "certificate.seal.line": "확인된 기록",
  "certificate.issuer.line": "civfix 발급 · civfix.org",
  "certificate.issuer.generated": "생성 {{timestamp}}",
  "certificate.verify.prompt": "civfix.org/service-record에서 이 기록을 확인하세요",
  "certificate.verify.fingerprint": "문서 지문",
  "certificate.footer.page": "{{total}}페이지 중 {{page}}페이지",
  "certificate.footer.timezone": "날짜는 태평양 시간(America/Los_Angeles) 기준이에요.",
  "certificate.error.no_hours": "아직 기록된 봉사 시간이 없어요.",

  // ---- Guest event RSVP -------------------------------------------------------------------------
  "email.guest_otp.subject": "{{title}} 참가 신청 코드",
  "email.guest_otp.body":
    "{{title}} 참가 신청 코드는 {{code}}입니다. {{minutes}}분 후에 만료됩니다. 요청하지 않으셨다면 이 이메일을 무시하셔도 됩니다.",
  "email.guest_confirmed.subject": "{{title}} 참가자 명단에 등록되었습니다",
  "email.guest_confirmed.body":
    "{{title}}에 참가 신청이 완료되었습니다. 현장에서는 이름으로 체크인하며, 출력할 티켓은 없습니다. 마음이 바뀌셨나요? 여기에서 취소하세요: {{link}}",
  "email.guest_promoted.subject": "{{title}}에 자리가 생겼습니다",
  "email.guest_promoted.body":
    "{{when}}에 열리는 {{title}}에 자리가 생겼습니다. 대기자 명단에 계셨고, 주최자가 자리를 잡아두고 있습니다. 아직 참가를 원하시면 행사 페이지를 확인하고 주최자에게 문의하세요: {{link}}",
  "email.guest_updated.subject": "{{title}} 세부 정보가 변경되었습니다",
  "email.guest_updated.body":
    "{{title}}의 세부 정보가 변경되었습니다. 이제 {{when}}에 {{place}}에서 시작합니다. 참석이 어려우시면 확인 메시지의 취소 링크를 이용하세요.",
  "email.guest_cancelled.subject": "{{title}}이(가) 취소되었습니다",
  "email.guest_cancelled.body": "주최자가 {{title}}을(를) 취소했습니다. 따로 하실 일은 없습니다.",
  "email.guest_cancelled.body_reason": "주최자가 {{title}}을(를) 취소했습니다. 사유: {{reason}}",
  "sms.guest_otp.body":
    "{{code}}은(는) {{title}} 참가 신청을 위한 civfix 코드입니다. 메시지 및 데이터 요금이 부과될 수 있습니다. 수신을 원하지 않으시면 STOP으로 답장하세요.",
  "sms.guest_confirmed.body":
    "{{title}} 참가자 명단에 등록되었습니다. 취소: {{link}} 수신을 원하지 않으시면 STOP으로 답장하세요.",
  "sms.guest_updated.body": "{{title}} 변경: 이제 {{when}}, 장소 {{place}}. 수신을 원하지 않으시면 STOP으로 답장하세요.",
  "sms.guest_cancelled.body": "주최자가 {{title}}을(를) 취소했습니다. 수신을 원하지 않으시면 STOP으로 답장하세요.",

}
