import type { ChatMessageDTO } from "@civfix/shared"

export function neutralizeChatViewerFields(dto: ChatMessageDTO): ChatMessageDTO {
  const next: ChatMessageDTO = {
    ...dto,
    mine: false,
    reactions: (dto.reactions ?? []).map((r) => (r.mine ? { ...r, mine: false } : r)),
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
