import type { ChatMessageDTO } from "@civfix/shared"

export function neutralizeChatViewerFields(dto: ChatMessageDTO): ChatMessageDTO {
  const next: ChatMessageDTO = {
    ...dto,
    mine: false,
    reactions: (dto.reactions ?? []).map((r) => (r.mine ? { ...r, mine: false } : r)),
  }
  // The sender's copy links a still-validating attachment to its raw upload (unscanned, EXIF intact) so
  // they see their own photo at once. The contract has no url-less attachment, so the copy everyone else
  // gets leaves it out until a later read finds it ready.
  if (dto.attachments != null) {
    next.attachments = dto.attachments.filter((a) => a.status === "ready")
  }
  if (dto.poll != null) {
    next.poll = {
      ...dto.poll,
      myVote: [],
      options: dto.poll.options.map((o) => (o.mine ? { ...o, mine: false } : o)),
    }
  }
  return next
}
