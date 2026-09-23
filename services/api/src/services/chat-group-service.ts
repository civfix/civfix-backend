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
import { assertNoSlur } from "../abuse/slur-filter.js"
import { isOfficialAccount } from "../auth/official-account.js"
import { NO_AFFILIATIONS, withAffiliation, type AffiliationLoader } from "./affiliation.js"

export const GROUP_MEMBERS_DEFAULT_LIMIT = 25
export const GROUP_MEMBERS_MAX_LIMIT = 50

const INVITE_BLOCK_SCAN_MEMBERS = 200

export interface ChatGroupServiceDeps {
  groups: ChatGroupRepository
  isMutedFor?: (userId: string, groupId: string) => Promise<boolean>
  affiliations?: AffiliationLoader
}

const forbidden = (message: string, code: string): AppError =>
  new AppError(ErrorCode.FORBIDDEN, message, { fields: { code } })

const groupNotFound = (): AppError => AppError.notFound("Group not found")

function toMemberDTO(view: GroupMemberView): GroupMemberDTO {
  return { user: view.user, role: view.role, joinedAt: view.joinedAt.toISOString() }
}

export interface AddGroupMembersResult {
  page: ListGroupMembersResponse
  added: string[]
}

export interface ChatGroupService {
  createGroup(ownerId: string, req: CreateChatGroupRequest): Promise<ChatGroupDTO>
  getGroup(viewerId: string, groupId: string): Promise<ChatGroupDTO>
  updateGroup(userId: string, req: UpdateChatGroupRequest): Promise<ChatGroupDTO>
  addMembers(userId: string, req: AddGroupMembersRequest): Promise<AddGroupMembersResult>
  removeMember(actorId: string, groupId: string, targetId: string): Promise<void>
  setMemberRole(
    actorId: string,
    groupId: string,
    targetId: string,
    role: "admin" | "member",
  ): Promise<GroupMemberDTO>
  listMembers(viewerId: string, req: ListGroupMembersRequest): Promise<ListGroupMembersResponse>
  joinGroup(userId: string, groupId: string): Promise<ChatGroupDTO>
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

  async function filterInvitees(actorId: string, memberIds: string[]): Promise<string[]> {
    const unique = [...new Set(memberIds)].filter((id) => id !== actorId && !isOfficialAccount(id))
    return groups.invitableIdsOf(actorId, unique)
  }

  const blockedKey = (a: string, b: string): string => `${a}|${b}`

  function greedyPairwise(candidates: string[], blocked: Set<string>): string[] {
    const accepted: string[] = []
    for (const c of candidates) {
      if (accepted.every((a) => !blocked.has(blockedKey(c, a)))) accepted.push(c)
    }
    return accepted
  }

  async function filterPairwise(candidates: string[]): Promise<string[]> {
    if (candidates.length < 2) return candidates
    const blocked = await groups.blockedPairsAmong(candidates)
    return greedyPairwise(candidates, blocked)
  }

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
    const blocked = await groups.blockedPairsAmong([...candidates, ...existing])
    const rosterOk = candidates.filter((c) => !existing.some((m) => blocked.has(blockedKey(c, m))))
    return greedyPairwise(rosterOk, blocked)
  }

  async function requireGroup(groupId: string): Promise<ChatGroupView> {
    const view = await groups.findById(groupId)
    if (view === null) throw groupNotFound()
    return view
  }

  async function readableGroup(
    viewerId: string,
    groupId: string,
  ): Promise<{ view: ChatGroupView; role: GroupMemberRole | null }> {
    const [view, role] = await Promise.all([
      groups.findById(groupId),
      groups.roleOf(groupId, viewerId),
    ])
    if (view === null || (role === null && view.visibility === "private")) {
      throw forbidden("You aren't a member of this group.", "not_a_member")
    }
    return { view, role }
  }

  async function requireReadable(
    viewerId: string,
    groupId: string,
  ): Promise<GroupMemberRole | null> {
    return (await readableGroup(viewerId, groupId)).role
  }

  async function firstMembersPage(
    groupId: string,
    viewerId: string,
  ): Promise<ListGroupMembersResponse> {
    const page = await groups.listMembers(groupId, viewerId, null, GROUP_MEMBERS_DEFAULT_LIMIT)
    return { members: page.members.map(toMemberDTO), nextCursor: page.nextCursor }
  }

  return {
    async createGroup(ownerId, req) {
      assertNoSlur(req.name, "name")
      assertNoSlur(req.description ?? null, "description")
      const memberIds = await filterPairwise(await filterInvitees(ownerId, req.memberIds))
      const id = await groups.create(
        {
          kind: req.kind,
          name: req.name,
          description:
            req.description !== undefined && req.description !== "" ? req.description : null,
          avatarUploadId: req.avatarUploadId ?? null,
          ownerId,
          visibility: req.visibility,
        },
        memberIds,
      )
      const view = await requireGroup(id)
      return {
        ...(await toGroupDTO(view, ownerId, "owner")),
        muted: false,
      }
    },

    async getGroup(viewerId, groupId) {
      const { view, role } = await readableGroup(viewerId, groupId)
      return toGroupDTO(view, viewerId, role)
    },

    async updateGroup(userId, req) {
      const role = await groups.roleOf(req.id, userId)
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only the owner or an admin can update this group.", "update_forbidden")
      }
      assertNoSlur(req.name ?? null, "name")
      assertNoSlur(req.description ?? null, "description")
      const view = await requireGroup(req.id)
      if (req.visibility !== undefined && req.visibility !== view.visibility && role !== "owner") {
        throw forbidden(
          "Only the owner can change this group's visibility.",
          "visibility_owner_only",
        )
      }
      await groups.update(
        req.id,
        {
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.description !== undefined
            ? { description: req.description === "" ? null : req.description }
            : {}),
          ...(req.avatarUploadId !== undefined ? { avatarUploadId: req.avatarUploadId } : {}),
          ...(req.visibility !== undefined ? { visibility: req.visibility } : {}),
        },
        userId,
      )
      const updated = await requireGroup(req.id)
      return toGroupDTO(updated, userId, role)
    },

    async addMembers(userId, req) {
      const role = await groups.roleOf(req.id, userId)
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only the owner or an admin can add members.", "add_members_forbidden")
      }
      await requireGroup(req.id)
      const invitees = await filterInviteesForRoom(userId, req.id, req.memberIds)
      await groups.addMembers(req.id, invitees)
      return { page: await firstMembersPage(req.id, userId), added: invitees }
    },

    async removeMember(actorId, groupId, targetId) {
      const [actorRole, targetRole] = await Promise.all([
        groups.roleOf(groupId, actorId),
        groups.roleOf(groupId, targetId),
      ])

      if (actorId === targetId) {
        if (targetRole === null) throw AppError.notFound("That user isn't a member of this group.")
        if (actorRole === "owner") {
          throw new AppError(ErrorCode.CONFLICT, "The owner can't leave their own group.", {
            fields: { code: "owner_must_stay" },
          })
        }
        await groups.removeMember(groupId, targetId)
        return
      }

      if (actorRole !== "owner" && actorRole !== "admin") {
        throw forbidden("Only the owner or an admin can remove members.", "remove_forbidden")
      }
      if (targetRole === null) throw AppError.notFound("That user isn't a member of this group.")
      if (targetRole === "owner" || (targetRole === "admin" && actorRole !== "owner")) {
        throw forbidden("You can't remove this member.", "remove_forbidden")
      }
      await groups.banMember(groupId, targetId, actorId)
    },

    async setMemberRole(actorId, groupId, targetId, role) {
      const actorRole = await groups.roleOf(groupId, actorId)
      if (actorRole !== "owner") {
        throw forbidden("Only the owner can change member roles.", "role_owner_only")
      }
      if (targetId === actorId) {
        throw AppError.validation({ userId: "The owner's role can't be changed." })
      }
      const targetRole = await groups.roleOf(groupId, targetId)
      if (targetRole === null) throw AppError.notFound("That user isn't a member of this group.")
      if (targetRole === "owner") {
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
      const affiliations = deps.affiliations
        ? await deps.affiliations(
            page.members.map((m) => m.user.id),
            viewerId,
          )
        : NO_AFFILIATIONS
      return {
        members: page.members.map((m) => {
          const dto = toMemberDTO(m)
          return { ...dto, user: withAffiliation(dto.user, affiliations) }
        }),
        nextCursor: page.nextCursor,
      }
    },

    async joinGroup(userId, groupId) {
      const view = await groups.findById(groupId)
      if (view === null || view.visibility !== "public") {
        throw forbidden("This group isn't open to join.", "not_public")
      }
      const role = await groups.roleOf(groupId, userId)
      if (role !== null) {
        return toGroupDTO(view, userId, role)
      }
      if (!(await groups.joinUnlessBanned(groupId, userId))) {
        const concurrentRole = await groups.roleOf(groupId, userId)
        if (concurrentRole === null) {
          throw forbidden("This group isn't open to join.", "not_public")
        }
        return toGroupDTO(view, userId, concurrentRole)
      }
      const refreshed = await requireGroup(groupId)
      return toGroupDTO(refreshed, userId, "member")
    },

    requireReadable,
  }
}
