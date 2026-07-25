/**
 * P4 Task 4.3: the chat-group MANAGEMENT service — every authorization gate for the /groups surface
 * lives here, over an injected repo (factory-with-deps like chat-edit-service / chat-bells so the
 * whole gate ladder is testable without Fastify).
 *
 * THE ROLE MATRIX (management surface; message powers live in chat-room-roles.ts):
 *
 *   action                     | owner | admin | member | non-member
 *   ---------------------------+-------+-------+--------+-----------
 *   read (get/members/history) |  yes  |  yes  |  yes   | public groups only (403 private)
 *   update name/desc/avatar    |  yes  |  yes  |  403 update_forbidden
 *   change visibility          |  yes  |  403 visibility_owner_only (admins included)
 *   add members                |  yes  |  yes  |  403 add_members_forbidden
 *   remove a member            |  yes  |  yes  |  403 remove_forbidden
 *   remove an admin            |  yes  |  403 remove_forbidden (admins never remove admins)
 *   remove the owner           |  ——— nobody: 403 remove_forbidden ———
 *   leave (self-remove)        |  409 owner_must_stay | yes | yes |  404 (not a member)
 *   set role admin<->member    |  yes  |  403 role_owner_only (owner's own row: 422)
 *
 * Machine subcodes ride `fields.code` (the chat-edit-service convention — ErrorCode is a closed
 * enum, so clients key off httpStatus + fields.code).
 *
 * Blocked pairs: creating a group / adding members SKIPS (never errors on) any target the ACTOR is
 * blocked-either-way with — an invite is a social action from the actor, so a block in either
 * direction suppresses it silently (no block-relationship leak).
 *
 * Bells: NOTHING here notifies (group_chat bells land in Task 4.5).
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type {
  AddGroupMembersRequest,
  ChatGroupDTO,
  CreateChatGroupRequest,
  GroupMemberDTO,
  ListGroupMembersRequest,
  ListGroupMembersResponse,
  UpdateChatGroupRequest,
} from "@civfix/shared"
import type {
  ChatGroupRepository,
  ChatGroupView,
  GroupMemberRole,
  GroupMemberView,
} from "./chat-group-repository.drizzle.js"

/** Default / max page size for the member list (max mirrors the shared schema's `.max(50)`). */
export const GROUP_MEMBERS_DEFAULT_LIMIT = 25
export const GROUP_MEMBERS_MAX_LIMIT = 50

/**
 * SECURITY (M12): how many EXISTING members are considered when checking an invitee against the room's
 * current roster for a block. The check itself is one bulk query per invitee (see
 * filterInviteesForRoom), so this bounds the ROW count each of those queries scans, not the query
 * count. Groups are small social rooms; the oldest N members are the ones an invitee is most likely to
 * have a history with.
 */
const INVITE_BLOCK_SCAN_MEMBERS = 200

export interface ChatGroupServiceDeps {
  groups: ChatGroupRepository
  /** conversation_mutes lookup for roomKind 'group'. Absent (offline harnesses) => never muted. */
  isMutedFor?: (userId: string, groupId: string) => Promise<boolean>
}

const forbidden = (message: string, code: string): AppError =>
  new AppError(ErrorCode.FORBIDDEN, message, { fields: { code } })

const groupNotFound = (): AppError => AppError.notFound("Group not found")

function toMemberDTO(view: GroupMemberView): GroupMemberDTO {
  return { user: view.user, role: view.role, joinedAt: view.joinedAt.toISOString() }
}

export interface ChatGroupService {
  createGroup(ownerId: string, req: CreateChatGroupRequest): Promise<ChatGroupDTO>
  getGroup(viewerId: string, groupId: string): Promise<ChatGroupDTO>
  updateGroup(userId: string, req: UpdateChatGroupRequest): Promise<ChatGroupDTO>
  addMembers(userId: string, req: AddGroupMembersRequest): Promise<ListGroupMembersResponse>
  /** Remove `targetId` (owner/admin moderation) or leave (targetId === actorId). */
  removeMember(actorId: string, groupId: string, targetId: string): Promise<void>
  setMemberRole(
    actorId: string,
    groupId: string,
    targetId: string,
    role: "admin" | "member",
  ): Promise<GroupMemberDTO>
  listMembers(viewerId: string, req: ListGroupMembersRequest): Promise<ListGroupMembersResponse>
  /**
   * P5 self-serve join: any authed user may join a visibility='public' group/channel (403 not_public
   * otherwise). Idempotent — a re-join keeps the caller's existing role (no dupe row) and returns the
   * current state; a fresh join inserts role 'member'. Returns the refreshed ChatGroupDTO with myRole.
   */
  joinGroup(userId: string, groupId: string): Promise<ChatGroupDTO>
  /**
   * Readability gate shared with the message routes (history / pins): members always; non-members
   * only when the group is public. Throws 404 (unknown group) / 403 (private, not a member).
   * Returns the viewer's role (null = non-member of a public group).
   */
  requireReadable(viewerId: string, groupId: string): Promise<GroupMemberRole | null>
}

export function makeChatGroupService(deps: ChatGroupServiceDeps): ChatGroupService {
  const { groups } = deps

  const isMuted = (userId: string, groupId: string): Promise<boolean> =>
    deps.isMutedFor ? deps.isMutedFor(userId, groupId) : Promise.resolve(false)

  async function toGroupDTO(
    view: ChatGroupView,
    viewerId: string,
    knownRole?: GroupMemberRole | null,
  ): Promise<ChatGroupDTO> {
    const [myRole, muted] = await Promise.all([
      knownRole !== undefined ? Promise.resolve(knownRole) : groups.roleOf(view.id, viewerId),
      isMuted(viewerId, view.id),
    ])
    return {
      id: view.id,
      kind: view.kind,
      name: view.name,
      description: view.description,
      avatar: view.avatar,
      visibility: view.visibility,
      ownerId: view.ownerId,
      memberCount: view.memberCount,
      myRole,
      muted,
      createdAt: view.createdAt.toISOString(),
    }
  }

  /** avatarUploadId -> media_assets id; an unknown uploadId is silently ignored (users-avatar stance). */
  async function resolveAvatar(uploadId: string | undefined): Promise<string | null> {
    if (uploadId === undefined) return null
    return groups.findMediaIdByUploadId(uploadId)
  }

  /**
   * Dedupe + drop self, then ONE bulk repo query drops unknown/deleted users (a schema-valid but
   * nonexistent uuid would otherwise 500 on the membership FK) and blocked-either-way pairs.
   * Order preserved; dropped ids are silently skipped, never errors.
   */
  async function filterInvitees(actorId: string, memberIds: string[]): Promise<string[]> {
    const unique = [...new Set(memberIds)].filter((id) => id !== actorId)
    return groups.invitableIdsOf(actorId, unique)
  }

  /**
   * SECURITY (M12): the invitee filter for an EXISTING room — actor-relative blocks (filterInvitees)
   * PLUS pairwise blocks against the room's current roster.
   *
   * Membership needs no consent in this product (an owner/admin adds you and you are in), so the block
   * filter is the only thing standing between "I blocked you" and "a third party put us in the same
   * room, repeatedly". Before this, `invitableIdsOf` only excluded pairs blocked with the ACTOR, so any
   * owner/admin — including one the blocked pair have never interacted with — could force them
   * together, and re-do it every time either one left.
   *
   * Shape: ONE bulk query per invitee (invitableIdsOf run "from the invitee's side" over the existing
   * roster), not one per pair. An invitee blocked either-way with ANY current member is silently
   * skipped — the same stance the actor-relative filter already takes, so no block relationship leaks
   * back to the inviter.
   *
   * Known nuance: `invitableIdsOf` also drops soft-deleted users, so an existing member whose account
   * was deleted is indistinguishable here from a block and makes us skip the invitee. That errs toward
   * NOT adding someone, which is the safe direction for a consent-less join.
   */
  async function filterInviteesForRoom(
    actorId: string,
    groupId: string,
    memberIds: string[],
  ): Promise<string[]> {
    const candidates = await filterInvitees(actorId, memberIds)
    if (candidates.length === 0) return candidates
    const existing = (await groups.listMemberIds(groupId))
      .filter((id) => !candidates.includes(id))
      .slice(0, INVITE_BLOCK_SCAN_MEMBERS)
    if (existing.length === 0) return candidates
    const verdicts = await Promise.all(
      candidates.map(async (candidate) => {
        const ok = await groups.invitableIdsOf(candidate, existing)
        return ok.length === existing.length
      }),
    )
    return candidates.filter((_, i) => verdicts[i] === true)
  }

  async function requireGroup(groupId: string): Promise<ChatGroupView> {
    const view = await groups.findById(groupId)
    if (view === null) throw groupNotFound()
    return view
  }

  /**
   * SECURITY (L8): unknown group and private-group-non-member collapse into the SAME 403
   * `not_a_member`, matching the WS lane (ws/frame-handler authorizeRoom), which deliberately returns a
   * uniform "You are not a member of this group." for both. The previous 404-for-unknown /
   * 403-for-private split was an existence oracle: a stranger could enumerate group ids and learn which
   * private rooms exist. A 404 is only correct once the caller is known to be able to see the room.
   */
  async function requireReadable(viewerId: string, groupId: string): Promise<GroupMemberRole | null> {
    const [view, role] = await Promise.all([groups.findById(groupId), groups.roleOf(groupId, viewerId)])
    if (view === null || (role === null && view.visibility === "private")) {
      throw forbidden("You aren't a member of this group.", "not_a_member")
    }
    return role
  }

  async function firstMembersPage(groupId: string, viewerId: string): Promise<ListGroupMembersResponse> {
    const page = await groups.listMembers(groupId, viewerId, null, GROUP_MEMBERS_DEFAULT_LIMIT)
    return { members: page.members.map(toMemberDTO), nextCursor: page.nextCursor }
  }

  return {
    async createGroup(ownerId, req) {
      const [avatarMediaId, memberIds] = await Promise.all([
        resolveAvatar(req.avatarUploadId),
        filterInvitees(ownerId, req.memberIds),
      ])
      const id = await groups.create(
        {
          kind: req.kind,
          name: req.name,
          description: req.description !== undefined && req.description !== "" ? req.description : null,
          avatarMediaId,
          ownerId,
          visibility: req.visibility,
        },
        memberIds,
      )
      const view = await requireGroup(id)
      // Fresh group: the creator is the owner and cannot have muted a room that did not exist.
      return {
        ...(await toGroupDTO(view, ownerId, "owner")),
        muted: false,
      }
    },

    async getGroup(viewerId, groupId) {
      const role = await requireReadable(viewerId, groupId)
      const view = await requireGroup(groupId)
      return toGroupDTO(view, viewerId, role)
    },

    async updateGroup(userId, req) {
      // L8: the ACTOR'S power is gated BEFORE the room is confirmed to exist, so an unknown id and a
      // room the caller has no power in answer identically (403 update_forbidden) — no existence
      // oracle. The same ordering is applied to every mutation below. `roleOf` on an unknown group
      // returns null, so this is also the unknown-group answer.
      const role = await groups.roleOf(req.id, userId)
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only the owner or an admin can update this group.", "update_forbidden")
      }
      const view = await requireGroup(req.id)
      if (req.visibility !== undefined && req.visibility !== view.visibility && role !== "owner") {
        throw forbidden("Only the owner can change this group's visibility.", "visibility_owner_only")
      }
      const avatarMediaId =
        req.avatarUploadId !== undefined ? await resolveAvatar(req.avatarUploadId) : null
      await groups.update(req.id, {
        ...(req.name !== undefined ? { name: req.name } : {}),
        // The contract's clear sentinel is "" (no null on the wire) -> stored NULL.
        ...(req.description !== undefined
          ? { description: req.description === "" ? null : req.description }
          : {}),
        // Only a RESOLVED upload flips the avatar (an unknown uploadId is ignored, never nulls it out).
        ...(avatarMediaId !== null ? { avatarMediaId } : {}),
        ...(req.visibility !== undefined ? { visibility: req.visibility } : {}),
      })
      const updated = await requireGroup(req.id)
      return toGroupDTO(updated, userId, role)
    },

    async addMembers(userId, req) {
      // L8: actor power first (see updateGroup) — unknown group and no-power both answer 403.
      const role = await groups.roleOf(req.id, userId)
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only the owner or an admin can add members.", "add_members_forbidden")
      }
      await requireGroup(req.id)
      // M12: actor-relative AND roster-pairwise block filtering (see filterInviteesForRoom).
      const invitees = await filterInviteesForRoom(userId, req.id, req.memberIds)
      await groups.addMembers(req.id, invitees)
      return firstMembersPage(req.id, userId)
    },

    async removeMember(actorId, groupId, targetId) {
      const [actorRole, targetRole] = await Promise.all([
        groups.roleOf(groupId, actorId),
        groups.roleOf(groupId, targetId),
      ])

      if (actorId === targetId) {
        // Self-remove = leave: the 404 is about the caller's OWN row, so it leaks nothing.
        if (targetRole === null) throw AppError.notFound("That user isn't a member of this group.")
        // Any role EXCEPT the owner may leave (the room must always have its owner).
        if (actorRole === "owner") {
          throw new AppError(ErrorCode.CONFLICT, "The owner can't leave their own group.", {
            fields: { code: "owner_must_stay" },
          })
        }
        await groups.removeMember(groupId, targetId)
        return
      }

      // Review fix (membership oracle): gate the ACTOR'S power BEFORE looking at the target, so a
      // stranger probing a private group's roster gets a uniform 403 — never a 404-vs-403 signal
      // revealing whether some user is a member. L8 extends this to the ROOM itself: the dropped
      // requireGroup means an unknown group id now also lands on this 403 (roleOf returns null)
      // instead of a 404 that confirmed the room exists.
      if (actorRole !== "owner" && actorRole !== "admin") {
        throw forbidden("Only the owner or an admin can remove members.", "remove_forbidden")
      }
      if (targetRole === null) throw AppError.notFound("That user isn't a member of this group.")
      // The owner is never removable; admins are removable ONLY by the owner.
      if (targetRole === "owner" || (targetRole === "admin" && actorRole !== "owner")) {
        throw forbidden("You can't remove this member.", "remove_forbidden")
      }
      await groups.removeMember(groupId, targetId)
    },

    async setMemberRole(actorId, groupId, targetId, role) {
      // L8: no requireGroup pre-check — an unknown group makes roleOf null, which lands on the same
      // 403 role_owner_only a non-owner gets, so existence never leaks.
      const actorRole = await groups.roleOf(groupId, actorId)
      if (actorRole !== "owner") {
        throw forbidden("Only the owner can change member roles.", "role_owner_only")
      }
      if (targetId === actorId) {
        // The owner's own row is not assignable (exactly one owner, fixed at creation).
        throw AppError.validation({ userId: "The owner's role can't be changed." })
      }
      const targetRole = await groups.roleOf(groupId, targetId)
      if (targetRole === null) throw AppError.notFound("That user isn't a member of this group.")
      if (targetRole === "owner") {
        // Unreachable while actor is THE owner and self is excluded; kept as a defensive 422.
        throw AppError.validation({ userId: "The owner's role can't be changed." })
      }
      await groups.setRole(groupId, targetId, role)
      const member = await groups.findMember(groupId, targetId, actorId)
      if (member === null) throw AppError.notFound("That user isn't a member of this group.")
      return toMemberDTO(member)
    },

    async listMembers(viewerId, req) {
      await requireReadable(viewerId, req.id)
      const limit = Math.min(
        Math.max(req.limit ?? GROUP_MEMBERS_DEFAULT_LIMIT, 1),
        GROUP_MEMBERS_MAX_LIMIT,
      )
      const page = await groups.listMembers(req.id, viewerId, req.cursor ?? null, limit)
      return { members: page.members.map(toMemberDTO), nextCursor: page.nextCursor }
    },

    async joinGroup(userId, groupId) {
      // L8: unknown group answers exactly like a private one (403 not_public) — a self-serve join is
      // the most enumerable surface there is, so it must not distinguish "no such room" from
      // "invite-only room".
      const view = await groups.findById(groupId)
      if (view === null || view.visibility !== "public") {
        throw forbidden("This group isn't open to join.", "not_public")
      }
      // Idempotent: addMembers is ON CONFLICT DO NOTHING as role 'member', so a re-join keeps an
      // existing owner/admin/member row untouched (no dupe, no demotion). Blocks are deliberately NOT
      // consulted — joining a PUBLIC room is the joiner's own action on a public civic surface, mirroring
      // the WS report lane (public join, blocks gate the DM lane only); a block never hides a public group.
      const role = await groups.roleOf(groupId, userId)
      if (role === null) await groups.addMembers(groupId, [userId])
      // Re-read so memberCount / myRole reflect the (possibly) new membership row.
      const refreshed = await requireGroup(groupId)
      return toGroupDTO(refreshed, userId, role ?? "member")
    },

    requireReadable,
  }
}
