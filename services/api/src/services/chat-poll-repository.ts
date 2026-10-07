/** dm is excluded upstream: a poll needs an audience. */
export type PollRoomColumn = "cleanup_id" | "report_id" | "group_id"

export interface CreatePollRow {
  roomColumn: PollRoomColumn
  roomId: string
  question: string
  options: string[]
  allowMultiple: boolean
  anonymous: boolean
  createdBy: string
}

export interface PollMeta {
  messageId: string
  createdBy: string
  closedAt: Date | null
  allowMultiple: boolean
  optionIdxs: number[]
}

export interface ChatPollRepository {
  /** `messageId` comes from the container's id factory so it matches the other chat write paths. */
  create(input: CreatePollRow, messageId: string): Promise<string>
  findPollMeta(messageId: string): Promise<PollMeta | null>
  /**
   * An empty `optionIdxs` retracts. The idxs must already be validated against the poll's options. The
   * tx re-asserts the poll is still open under a share lock, so a close racing the vote wins and the
   * replace no-ops.
   */
  replaceVotes(pollId: string, userId: string, optionIdxs: number[]): Promise<void>
  /** Idempotent: a re-close keeps the original closed_at and never moves the timestamp. */
  close(pollId: string): Promise<void>
}
