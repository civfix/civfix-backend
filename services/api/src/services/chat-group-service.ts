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

  async function requireGroup(groupId: string): Promise<ChatGroupView> {
    const view = await groups.findById(groupId)
    if (view === null) throw groupNotFound()
    return view
  }

  async function requireReadable(viewerId: string, groupId: string): Promise<GroupMemberRole | null> {
    const view = await requireGroup(groupId)
    const role = await groups.roleOf(groupId, viewerId)
    if (role === null && view.visibility === "private") {
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
      const view = await requireGroup(req.id)
      const role = await groups.roleOf(req.id, userId)
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only the owner or an admin can update this group.", "update_forbidden")
      }
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
      await requireGroup(req.id)
      const role = await groups.roleOf(req.id, userId)
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only the owner or an admin can add members.", "add_members_forbidden")
      }
      const invitees = await filterInvitees(userId, req.memberIds)
      await groups.addMembers(req.id, invitees)
      return firstMembersPage(req.id, userId)
    },

    async removeMember(actorId, groupId, targetId) {
      await requireGroup(groupId)
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
      // revealing whether some user is a member.
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
      await requireGroup(groupId)
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

    requireReadable,
  }
}
