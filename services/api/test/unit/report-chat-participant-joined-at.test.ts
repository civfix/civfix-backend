import { describe, expect, it } from "vitest"
import {
  toReportParticipantDTO,
  type ReportMemberRowSelect,
} from "../../src/services/report-chat-repository.drizzle.js"

describe("toReportParticipantDTO joinedAt", () => {
  it("serializes the timestamptz the driver returns as a Date into the contract's ISO string", () => {
    const joinedAt = new Date("2026-07-31T08:15:00.000Z")
    const row = {
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "member",
      joined_at: joinedAt,
      display_name: "Ada",
      handle: "ada",
      bio: null,
      avatar_url: null,
      user_deleted_at: null,
      is_following: false,
      blocked_pair: false,
    } as unknown as ReportMemberRowSelect

    const dto = toReportParticipantDTO(row)

    expect(typeof dto.joinedAt).toBe("string")
    expect(dto.joinedAt).toBe("2026-07-31T08:15:00.000Z")
  })
})
