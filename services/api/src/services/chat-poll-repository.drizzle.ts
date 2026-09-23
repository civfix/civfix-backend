/**
 * A poll IS a chat_messages row with kind='poll' (body = the question, for previews and excerpts) plus a
 * three-table subtree keyed on that message's id.
 *
 * This repo never re-reads a ChatMessageDTO itself: the service re-reads through the chat repository,
 * which depends on `loadPollsFor` here. One direction, so no import cycle.
 *
 * An anonymous poll never exposes voter identity because the DTO has no voter field at all.
 */

import type { Queryable, Sql } from "../db/client.js"
import type { PollDTO, PollOptionDTO } from "@civfix/shared"

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

export function makeChatPollRepository(sql: Sql): ChatPollRepository {
  return {
    async create(input: CreatePollRow, messageId: string): Promise<string> {
      const cleanupId = input.roomColumn === "cleanup_id" ? input.roomId : null
      const reportId = input.roomColumn === "report_id" ? input.roomId : null
      const groupId = input.roomColumn === "group_id" ? input.roomId : null
      await sql.begin(async (tx) => {
        // Exactly one room ref is set, as the chat_messages three-way XOR check requires.
        await tx`
          INSERT INTO chat_messages (id, cleanup_id, report_id, group_id, sender_id, body, kind)
          VALUES (${messageId}, ${cleanupId}, ${reportId}, ${groupId}, ${input.createdBy}, ${input.question}, 'poll')
        `
        await tx`
          INSERT INTO chat_polls (message_id, question, allow_multiple, anonymous, created_by)
          VALUES (${messageId}, ${input.question}, ${input.allowMultiple}, ${input.anonymous}, ${input.createdBy})
        `
        const optionRows = input.options.map((text, idx) => ({ poll_id: messageId, idx, text }))
        await tx`INSERT INTO chat_poll_options ${tx(optionRows, "poll_id", "idx", "text")}`
      })
      return messageId
    },

    async findPollMeta(messageId: string): Promise<PollMeta | null> {
      const rows = await sql<
        {
          message_id: string
          created_by: string
          closed_at: Date | null
          allow_multiple: boolean
        }[]
      >`
        SELECT message_id, created_by, closed_at, allow_multiple
        FROM chat_polls
        WHERE message_id = ${messageId}
        LIMIT 1
      `
      const r = rows[0]
      if (!r) return null
      const opts = await sql<{ idx: number }[]>`
        SELECT idx FROM chat_poll_options WHERE poll_id = ${messageId} ORDER BY idx ASC
      `
      return {
        messageId: r.message_id,
        createdBy: r.created_by,
        closedAt: r.closed_at,
        allowMultiple: r.allow_multiple,
        optionIdxs: opts.map((o) => o.idx),
      }
    },

    async replaceVotes(pollId: string, userId: string, optionIdxs: number[]): Promise<void> {
      await sql.begin(async (tx) => {
        // Re-assert OPEN inside the tx, holding the poll row FOR SHARE. The service checked closed_at off
        // findPollMeta in an earlier statement, so a close committing in between would otherwise have let
        // this ballot land on a closed poll; the share lock makes `close` (an UPDATE of this row) wait, and
        // if the close won the race the re-check now sees it and the whole replace becomes a no-op (the
        // caller's re-read then shows the closed poll without the vote).
        const open = await tx<{ message_id: string }[]>`
          SELECT message_id FROM chat_polls
          WHERE message_id = ${pollId} AND closed_at IS NULL
          FOR SHARE
        `
        if (open.length === 0) return
        await tx`
          DELETE FROM chat_poll_votes WHERE poll_id = ${pollId} AND user_id = ${userId}
        `
        if (optionIdxs.length > 0) {
          const rows = optionIdxs.map((idx) => ({
            poll_id: pollId,
            option_idx: idx,
            user_id: userId,
          }))
          await tx`INSERT INTO chat_poll_votes ${tx(rows, "poll_id", "option_idx", "user_id")}`
        }
      })
    },

    async close(pollId: string): Promise<void> {
      await sql`
        UPDATE chat_polls SET closed_at = COALESCE(closed_at, now()) WHERE message_id = ${pollId}
      `
    },
  }
}

interface PollRowSelect {
  message_id: string
  question: string
  allow_multiple: boolean
  anonymous: boolean
  closed_at: Date | null
}

interface PollOptionRowSelect {
  poll_id: string
  idx: number
  text: string
  count: number
  mine_count: number
}

/**
 * Three grouped queries regardless of page size. Callers pass only live poll-kind ids: a deleted poll
 * hydrates as a plain tombstone with no `poll` field, because the poll body must not survive deletion.
 */
export async function loadPollsFor(
  sql: Queryable,
  ids: readonly string[],
  viewerUserId: string | null,
): Promise<Map<string, PollDTO>> {
  const distinct = [...new Set(ids)]
  if (distinct.length === 0) return new Map()

  const [polls, options, voters] = await Promise.all([
    sql<PollRowSelect[]>`
      SELECT message_id, question, allow_multiple, anonymous, closed_at
      FROM chat_polls
      WHERE message_id = ANY(${distinct}::uuid[])
    `,
    // A viewer-null filter (`v.user_id = NULL`) is never true, so mine_count is 0 for signed-out reads.
    sql<PollOptionRowSelect[]>`
      SELECT
        o.poll_id,
        o.idx,
        o.text,
        COUNT(v.user_id)::int AS count,
        COUNT(*) FILTER (WHERE v.user_id = ${viewerUserId})::int AS mine_count
      FROM chat_poll_options o
      LEFT JOIN chat_poll_votes v ON v.poll_id = o.poll_id AND v.option_idx = o.idx
      WHERE o.poll_id = ANY(${distinct}::uuid[])
      GROUP BY o.poll_id, o.idx, o.text
      ORDER BY o.poll_id, o.idx ASC
    `,
    // Distinct users, not vote rows: a multi-select ballot is one voter.
    sql<{ poll_id: string; total: number }[]>`
      SELECT poll_id, COUNT(DISTINCT user_id)::int AS total
      FROM chat_poll_votes
      WHERE poll_id = ANY(${distinct}::uuid[])
      GROUP BY poll_id
    `,
  ])

  const optionsByPoll = new Map<string, PollOptionDTO[]>()
  const myVoteByPoll = new Map<string, number[]>()
  for (const o of options) {
    const mine = o.mine_count > 0
    const list = optionsByPoll.get(o.poll_id) ?? []
    list.push({ idx: o.idx, text: o.text, count: o.count, mine })
    optionsByPoll.set(o.poll_id, list)
    if (mine) {
      const mv = myVoteByPoll.get(o.poll_id) ?? []
      mv.push(o.idx)
      myVoteByPoll.set(o.poll_id, mv)
    }
  }
  const totalByPoll = new Map(voters.map((v) => [v.poll_id, v.total]))

  const out = new Map<string, PollDTO>()
  for (const p of polls) {
    out.set(p.message_id, {
      question: p.question,
      options: optionsByPoll.get(p.message_id) ?? [],
      allowMultiple: p.allow_multiple,
      anonymous: p.anonymous,
      closed: p.closed_at !== null,
      totalVoters: totalByPoll.get(p.message_id) ?? 0,
      myVote: myVoteByPoll.get(p.message_id) ?? [],
    })
  }
  return out
}
