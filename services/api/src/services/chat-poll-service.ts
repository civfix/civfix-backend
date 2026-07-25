/**
 * P6 Task 6.3/6.4: the poll create / vote / close orchestration — gate ladder + atomic writes +
 * broadcast + member fan-out, over injected seams (chat-edit-service style: pure flow here, repos and
 * transport wired in the route). A poll is a chat message with kind='poll'; the write goes through the
 * poll repo, then the message is RE-READ through the chat repository so the returned + broadcast DTO
 * carries the fully-hydrated poll payload (chat-repository loadPollsFor).
 *
 * Every gate below is preceded, in a REPORT room, by the report VISIBILITY check (deps.isReportVisible) —
 * the same requireVisibleReport every report-chat.routes surface runs, because a report_chat_members row
 * outlives the report being unlisted / held / removed.
 *
 * GATES:
 *   - createPoll: room SEND permission (cleanup member / report member / group member+canPost — a
 *     channel's read-only members can't create), then the slur filter on the question + every option (the
 *     question is broadcast, quoted in reply excerpts and pushed in previews). Broadcasts a NEW `message`
 *     frame + fires the room's member bells (the same fan-out a normal send raises).
 *   - votePoll:   room MEMBERSHIP (any member incl. a channel's read-only readers; a public non-member
 *     403s). Closed poll -> 409 (fields.code poll_closed); an idx with no matching option, or a
 *     multi-idx ballot on a single-choice poll -> 422. The write is an ATOMIC replace (delete the
 *     voter's ballots + insert the new set in one tx); an empty ballot retracts. Broadcasts message_update.
 *   - closePoll:  the poll AUTHOR (created_by) OR a room MODERATOR (resolveChatPowers isModerator).
 *     Idempotent (a re-close keeps the original closed_at). Broadcasts message_update.
 *
 * A vote/close request carries only a messageId, so the room (kind + id) is resolved from the message
 * row; a missing / non-poll / tombstoned id is a 404 before any gate.
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type { ChatMessageDTO } from "@civfix/shared"
import type { ChatRepository } from "./chat-repository.drizzle.js"
import type { ChatPollRepository, PollRoomColumn } from "./chat-poll-repository.drizzle.js"
import { assertNoSlur } from "../abuse/slur-filter.js"

/** The rooms a poll can live in (dm excluded upstream — a poll needs an audience). */
export type PollRoomKind = "cleanup" | "report" | "group"

export interface CreatePollInput {
  roomKind: PollRoomKind
  roomId: string
  question: string
  options: string[]
  allowMultiple: boolean
  anonymous: boolean
  userId: string
}

export interface VotePollInput {
  messageId: string
  optionIdxs: number[]
  userId: string
}

export interface ClosePollInput {
  messageId: string
  userId: string
}

export interface ChatPollServiceDeps {
  chat: ChatRepository
  chatPolls: ChatPollRepository
  /** SEND permission for the create gate (cleanup member / report member / group member+canPost). */
  canSend(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  /** MEMBERSHIP for the vote gate (any member incl. channel readers; a public non-member is false). */
  isMember(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  /** Room moderator (close gate fallback) — resolveChatPowers().isModerator. */
  isModerator(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  /**
   * Report VISIBILITY (isReportVisibleTo: published+public, or the reporter's own), the gate every
   * report-chat.routes surface applies before touching a report room. Without it a member of a chat whose
   * report was since unlisted / held / soft-deleted could still create polls in it and fan bells to the
   * whole roster — membership rows outlive the report's visibility. Optional only so the offline harnesses
   * need not wire a report store; production MUST pass it.
   */
  isReportVisible?(reportId: string, userId: string): Promise<boolean>
  /** Injected message-id factory (matches the chat write paths' id source). */
  newId(): string
  /** Fan a NEW-message frame to the room (poll create). Best-effort. */
  broadcastMessage(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
  /** Fan a message_update frame to the room (vote / close). Best-effort. */
  broadcastUpdate(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
  /** Fire the room's member fan-out bells (create only; same bells a normal send raises). Best-effort. */
  notifyRoom(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
}

const ROOM_COLUMN: Record<PollRoomKind, PollRoomColumn> = {
  cleanup: "cleanup_id",
  report: "report_id",
  group: "group_id",
}

const pollClosed = (): AppError =>
  new AppError(ErrorCode.CONFLICT, "This poll is closed.", { fields: { code: "poll_closed" } })

export interface ChatPollService {
  createPoll(input: CreatePollInput): Promise<ChatMessageDTO>
  votePoll(input: VotePollInput): Promise<ChatMessageDTO>
  closePoll(input: ClosePollInput): Promise<ChatMessageDTO>
}

export function makeChatPollService(deps: ChatPollServiceDeps): ChatPollService {
  /**
   * Report-lane visibility gate (see deps.isReportVisible). 404 mirrors report-chat.routes'
   * requireVisibleReport: an invisible report must not be distinguishable from a missing one.
   */
  async function requireVisibleRoom(
    roomKind: PollRoomKind,
    roomId: string,
    userId: string,
  ): Promise<void> {
    if (roomKind !== "report" || !deps.isReportVisible) return
    if (!(await deps.isReportVisible(roomId, userId))) throw AppError.notFound("Report not found")
  }

  /**
   * Re-read the hydrated poll message (carries the poll DTO). `viewerUserId` null yields the NEUTRAL DTO
   * (myVote empty, every option `mine` false, reaction `mine` false) — the only shape safe to fan out
   * room-wide, and the reason vote/close read twice (see votePoll).
   */
  async function readMessage(
    roomKind: PollRoomKind,
    roomId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO> {
    const dto =
      roomKind === "report"
        ? await deps.chat.findReportMessage(roomId, messageId, viewerUserId)
        : roomKind === "group"
          ? await deps.chat.findGroupMessage(roomId, messageId, viewerUserId)
          : await deps.chat.findMessage(roomId, messageId, viewerUserId)
    // The row was just written/updated in this request; a null re-read is a lost race (deleted underneath).
    if (dto === null) throw AppError.notFound("Poll not found")
    return dto
  }

  /** Resolve a poll message's room (kind + id) from its row; 404 when missing / not a poll / tombstoned. */
  async function resolvePollRoom(
    messageId: string,
  ): Promise<{ roomKind: PollRoomKind; roomId: string }> {
    const meta = await deps.chat.findMessageMeta(messageId)
    if (meta === null || meta.kind !== "poll" || meta.deletedAt !== null) {
      throw AppError.notFound("Poll not found")
    }
    if (meta.reportId !== null) return { roomKind: "report", roomId: meta.reportId }
    if (meta.groupId !== null) return { roomKind: "group", roomId: meta.groupId }
    // A poll always sets exactly one room ref; cleanup is the remaining branch.
    return { roomKind: "cleanup", roomId: meta.cleanupId! }
  }

  return {
    async createPoll(input: CreatePollInput): Promise<ChatMessageDTO> {
      const { roomKind, roomId, userId } = input
      await requireVisibleRoom(roomKind, roomId, userId)
      if (!(await deps.canSend(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't create a poll in this chat.", {
          fields: { code: "poll_forbidden" },
        })
      }
      // Same content filter the WS send + the edit path apply: the question is broadcast, becomes reply
      // excerpts, and rides push previews, so it cannot be the one user-authored chat text that skips it.
      assertNoSlur(input.question, "question")
      for (const option of input.options) assertNoSlur(option, "options")
      const messageId = deps.newId()
      await deps.chatPolls.create(
        {
          roomColumn: ROOM_COLUMN[roomKind],
          roomId,
          question: input.question,
          options: input.options,
          allowMultiple: input.allowMultiple,
          anonymous: input.anonymous,
          createdBy: userId,
        },
        messageId,
      )
      const message = await readMessage(roomKind, roomId, messageId, userId)
      // Realtime: a NEW `message` frame (with the poll DTO) to the room, then the member bells a normal
      // send raises. Both best-effort — a fan-out failure never fails the create. ONE read is enough
      // here (unlike vote/close): a poll one statement old carries no votes and no reactions, so the
      // creator's viewer scope and the neutral scope are the same bytes.
      deps.broadcastMessage(roomKind, roomId, message)
      deps.notifyRoom(roomKind, roomId, message)
      return message
    },

    async votePoll(input: VotePollInput): Promise<ChatMessageDTO> {
      const { messageId, userId } = input
      // Dedupe the ballot up front: a schema-valid repeat idx (e.g. [0,0]) would pass every guard and
      // then trip the votes PK (23505 -> 500). A deduped repeat is semantically the same vote.
      const optionIdxs = [...new Set(input.optionIdxs)]
      const { roomKind, roomId } = await resolvePollRoom(messageId)
      await requireVisibleRoom(roomKind, roomId, userId)
      // Membership (not send-permission): a channel's read-only member may vote; a public non-member 403s.
      if (!(await deps.isMember(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You must be a member to vote.", {
          fields: { code: "poll_not_member" },
        })
      }
      const pollMeta = await deps.chatPolls.findPollMeta(messageId)
      if (pollMeta === null) throw AppError.notFound("Poll not found")
      if (pollMeta.closedAt !== null) throw pollClosed()
      // Multi-idx on a single-choice poll -> 422 (before the per-idx existence check).
      if (optionIdxs.length > 1 && !pollMeta.allowMultiple) {
        throw AppError.validation({ optionIdxs: "This poll allows only one choice." })
      }
      const valid = new Set(pollMeta.optionIdxs)
      if (optionIdxs.some((idx) => !valid.has(idx))) {
        throw AppError.validation({ optionIdxs: "Unknown poll option." })
      }
      // Atomic replace (empty = retract), then re-read the refreshed DTO twice: the viewer-aware one for
      // the voter's own response, and a NEUTRAL one for the room. Broadcasting the voter's copy leaked the
      // ballot — for an anonymous poll it put the voter's exact choices (myVote / options[].mine, plus
      // their reaction `mine` bits) on the wire to every member, and clients reconciling the frame in
      // place overwrote their OWN myVote with the voter's.
      //
      // KNOWN LIMITATION (do not "fix" by omitting the fields — see chat-polls-pg.test.ts's frame-parse
      // assertion): the room frame carries ONE poll payload for every recipient, and PollDTOSchema makes
      // `myVote` + `options[].mine` REQUIRED, so the neutral copy asserts "you have not voted" to members
      // who have. Clients replace the message by id (shared merge.ts reconcileInbound), so a member who
      // already voted sees their own selection clear until their next read — including the voter's other
      // sessions. Dropping the two fields from the frame is NOT an option server-side: the client parses
      // every inbound frame with WsServerMessageSchema and DISCARDS the whole frame on a miss
      // (ui chatSocketCore.handleRawFrame), so an omitted `mine`/`myVote` would silently kill live vote
      // counts and the closed flag for the entire room. Closing it properly needs BOTH halves of a
      // contract change: PollDTO's viewer fields made optional in @civfix/shared, and a client merge that
      // preserves absent viewer fields instead of replacing the message wholesale — then this call can
      // hand out the neutral-minus-viewer-fields shape. Until then the ballot LEAK (the security half)
      // stays closed and the stale `mine` (a display half that self-heals on the next read) is accepted.
      await deps.chatPolls.replaceVotes(messageId, userId, optionIdxs)
      const [message, roomView] = await Promise.all([
        readMessage(roomKind, roomId, messageId, userId),
        readMessage(roomKind, roomId, messageId, null),
      ])
      deps.broadcastUpdate(roomKind, roomId, roomView)
      return message
    },

    async closePoll(input: ClosePollInput): Promise<ChatMessageDTO> {
      const { messageId, userId } = input
      const { roomKind, roomId } = await resolvePollRoom(messageId)
      await requireVisibleRoom(roomKind, roomId, userId)
      const pollMeta = await deps.chatPolls.findPollMeta(messageId)
      if (pollMeta === null) throw AppError.notFound("Poll not found")
      const isAuthor = pollMeta.createdBy === userId
      // RULING (review): the close fallback is isModerator — so a report-chat OWNER (pin-only,
      // non-operator) CAN close others' polls. Deliberate: close is non-destructive + idempotent and
      // coherent with their pin power. (The ui only SHOWS Stop-poll to canDeleteOthers holders, which
      // under-shows for report owners — harmless direction, documented.)
      if (!isAuthor && !(await deps.isModerator(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't close this poll.", {
          fields: { code: "poll_close_forbidden" },
        })
      }
      // Idempotent: a re-close keeps the original closed_at (COALESCE in the repo). The room gets the
      // NEUTRAL DTO (see votePoll) — the closer's ballot is not the room's business either.
      await deps.chatPolls.close(messageId)
      const [message, roomView] = await Promise.all([
        readMessage(roomKind, roomId, messageId, userId),
        readMessage(roomKind, roomId, messageId, null),
      ])
      deps.broadcastUpdate(roomKind, roomId, roomView)
      return message
    },
  }
}
