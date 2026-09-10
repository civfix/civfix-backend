import {
  AcceptOrganizationInviteRequestSchema,
  ApplyOrganizationVerificationRequestSchema,
  CreateOrganizationRequestSchema,
  GetOrganizationRequestSchema,
  GetOrganizationVerificationRequestSchema,
  InviteOrganizationMemberRequestSchema,
  IdSchema,
  ListOrganizationInvitesRequestSchema,
  ListOrganizationMembersRequestSchema,
  OrgSlugSchema,
  RemoveOrganizationMemberRequestSchema,
  RevokeOrganizationInviteRequestSchema,
  SetOrganizationMemberRoleRequestSchema,
  UpdateOrganizationRequestSchema,
  type AcceptOrganizationInviteResponse,
  type GetOrganizationResponse,
  type GetOrganizationVerificationResponse,
  type InviteOrganizationMemberResponse,
  type ListMyOrganizationsResponse,
  type ListOrganizationInvitesResponse,
  type ListOrganizationMembersResponse,
  type RemoveOrganizationMemberResponse,
  type RevokeOrganizationInviteResponse,
  type SetOrganizationMemberRoleResponse,
  type UpdateOrganizationResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { parse, trimTextFields } from "../_validate.js"
import { perHost, perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"
import {
  makeOrganizationService,
  ORG_MEMBERS_DEFAULT_LIMIT,
  type OrganizationService,
  type OrganizationServiceDeps,
} from "../../services/host/organization-service.js"
import { makeDrizzleOrganizationRepository } from "../../services/host/organization-repository.drizzle.js"
import type { OrganizationRepository } from "../../services/host/organization-repository.types.js"
import { makeEligibilityBootstrap } from "../../services/payments/eligibility-bootstrap.js"
import { makeDrizzleEligibilityRepository } from "../../services/payments/eligibility-repository.drizzle.js"
import { makeEligibilityService } from "../../services/payments/eligibility-service.js"
import { makeDrizzleOrgPaymentsRepository } from "../../services/payments/org-payments-repository.drizzle.js"

export interface OrganizationOverrides {
  repo: OrganizationRepository
  counters?: OrganizationServiceDeps["counters"]
  presignLogo?: OrganizationServiceDeps["presignLogo"]
  now?: OrganizationServiceDeps["now"]
  newId?: OrganizationServiceDeps["newId"]
  newToken?: OrganizationServiceDeps["newToken"]
  onNonprofitVerified?: OrganizationServiceDeps["onNonprofitVerified"]
  mailer?: OrganizationServiceDeps["mailer"]
  notifier?: OrganizationServiceDeps["notifier"]
}

declare module "fastify" {
  interface FastifyInstance {
    organizationOverrides?: OrganizationOverrides
  }
}

const OrgIdParamsSchema = z.object({ id: IdSchema }).strict()

const OrgMemberParamsSchema = z.object({ id: IdSchema, userId: IdSchema }).strict()

const OrgInviteParamsSchema = z.object({ id: IdSchema, inviteId: IdSchema }).strict()

const OrgSlugParamsSchema = z.object({ slug: OrgSlugSchema }).strict()

const OrgMembersQuerySchema = z
  .object({ cursor: z.string().optional(), limit: z.string().optional() })
  .strict()

export const CREATE_ORG_RATE_LIMIT = perIdentity({ max: 5, timeWindow: "1 hour" })

export const ORG_MUTATION_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export const ORG_INVITE_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 hour" })

export const ORG_VERIFICATION_RATE_LIMIT = perIdentity({ max: 3, timeWindow: "1 hour" })

export const PUBLIC_ORG_READ_RATE_LIMIT = perHost({ max: 120, timeWindow: "1 minute" })

const CreateOrganizationBodySchema = trimTextFields(
  CreateOrganizationRequestSchema,
  "name",
  "description",
  "websiteUrl",
)

const UpdateOrganizationBodySchema = trimTextFields(
  UpdateOrganizationRequestSchema,
  "name",
  "description",
  "websiteUrl",
)

export function makeContainerOrganizationService(
  app: FastifyInstance,
  container: Container,
): OrganizationService {
  const overrides = app.organizationOverrides
  if (overrides !== undefined) {
    return makeOrganizationService({
      repo: overrides.repo,
      ...(overrides.counters !== undefined ? { counters: overrides.counters } : {}),
      ...(overrides.presignLogo !== undefined ? { presignLogo: overrides.presignLogo } : {}),
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
      ...(overrides.newToken !== undefined ? { newToken: overrides.newToken } : {}),
      ...(overrides.onNonprofitVerified !== undefined
        ? { onNonprofitVerified: overrides.onNonprofitVerified }
        : {}),
      ...(overrides.mailer !== undefined ? { mailer: overrides.mailer } : {}),
      ...(overrides.notifier !== undefined ? { notifier: overrides.notifier } : {}),
      logger: app.log,
    })
  }
  const sql = container.getDb().sql
  const bootstrap = makeEligibilityBootstrap({
    eligibility: makeEligibilityService({
      eligibility: makeDrizzleEligibilityRepository(sql),
      orgs: makeDrizzleOrgPaymentsRepository(sql),
      storage: container.storage,
      ...(container.env.PAYMENTS_ENABLED ? { jobs: container.jobs } : {}),
      logger: app.log,
    }),
    logger: app.log,
  })
  return makeOrganizationService({
    repo: makeDrizzleOrganizationRepository(sql),
    counters: container.getCounterStore(),
    presignLogo: (key: string) => container.storage.presignGet(key, MEDIA_GET_URL_TTL_SEC),
    onNonprofitVerified: bootstrap.onNonprofitVerified,
    mailer: container.mailer,
    // Lazy so the notification service is only built on the admin decide path that needs it.
    notifier: {
      createNotification: (userId, input) =>
        container.getNotificationService(app.log).createNotification(userId, input),
    },
    ...(container.env.WEB_ORIGINS[0] !== undefined
      ? { webOrigin: container.env.WEB_ORIGINS[0] }
      : {}),
    logger: app.log,
  })
}

export async function registerHostOrgRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function service(): OrganizationService {
    return makeContainerOrganizationService(app, container)
  }

  route(
    app,
    "createOrganization",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_ORG_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreateOrganizationBodySchema, request.body)
      const dto: GetOrganizationResponse = await service().createOrganization(body, userId)
      reply.status(201).send(dto)
    },
  )

  route(app, "listMyOrganizations", async (request, reply) => {
    const userId = requireAuth(request)
    const payload: ListMyOrganizationsResponse = {
      items: await service().listMyOrganizations(userId),
    }
    reply.status(200).send(payload)
  })

  route(
    app,
    "getOrganization",
    { config: { rateLimit: PUBLIC_ORG_READ_RATE_LIMIT } },
    async (request, reply) => {
      const { slug } = parse(OrgSlugParamsSchema, request.params)
      parse(GetOrganizationRequestSchema, { slug })
      const dto: GetOrganizationResponse = await service().getOrganizationBySlug(
        slug,
        request.auth?.userId ?? null,
      )
      reply.status(200).send(dto)
    },
  )

  route(
    app,
    "updateOrganization",
    { preHandler: csrfProtect, config: { rateLimit: ORG_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(OrgIdParamsSchema, request.params)
      const body = parse(UpdateOrganizationBodySchema, { ...(request.body as object), id })
      const dto: UpdateOrganizationResponse = await service().updateOrganization(id, body, userId)
      reply.status(200).send(dto)
    },
  )

  route(app, "listOrganizationMembers", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(OrgIdParamsSchema, request.params)
    const q = parse(OrgMembersQuerySchema, request.query ?? {})
    const validated = parse(ListOrganizationMembersRequestSchema, {
      id,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    })
    const payload: ListOrganizationMembersResponse = await service().listMembers(id, userId, {
      cursor: validated.cursor ?? null,
      limit: validated.limit ?? ORG_MEMBERS_DEFAULT_LIMIT,
    })
    reply.status(200).send(payload)
  })

  route(
    app,
    "inviteOrganizationMember",
    { preHandler: csrfProtect, config: { rateLimit: ORG_INVITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(OrgIdParamsSchema, request.params)
      const body = parse(InviteOrganizationMemberRequestSchema, {
        ...(request.body as object),
        id,
      })
      const payload: InviteOrganizationMemberResponse = await service().inviteMember(id, userId, body)
      reply.status(200).send(payload)
    },
  )

  route(app, "listOrganizationInvites", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(OrgIdParamsSchema, request.params)
    parse(ListOrganizationInvitesRequestSchema, { id })
    const payload: ListOrganizationInvitesResponse = await service().listInvites(id, userId)
    reply.status(200).send(payload)
  })

  route(
    app,
    "revokeOrganizationInvite",
    { preHandler: csrfProtect, config: { rateLimit: ORG_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, inviteId } = parse(OrgInviteParamsSchema, request.params)
      parse(RevokeOrganizationInviteRequestSchema, { id, inviteId })
      const payload: RevokeOrganizationInviteResponse = await service().revokeInvite(
        id,
        userId,
        inviteId,
      )
      reply.status(200).send(payload)
    },
  )

  // Token-addressed (no :id): the token identifies the org (DECISIONS §32). Accepting needs a session
  // whose verified email matches the invited address.
  route(
    app,
    "acceptOrganizationInvite",
    { preHandler: csrfProtect, config: { rateLimit: ORG_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(AcceptOrganizationInviteRequestSchema, request.body ?? {})
      const payload: AcceptOrganizationInviteResponse = await service().acceptInvite(
        userId,
        body.token,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "setOrganizationMemberRole",
    { preHandler: csrfProtect, config: { rateLimit: ORG_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireAuth(request)
      const { id, userId } = parse(OrgMemberParamsSchema, request.params)
      const body = parse(SetOrganizationMemberRoleRequestSchema, {
        ...(request.body as object),
        id,
        userId,
      })
      const payload: SetOrganizationMemberRoleResponse = await service().setMemberRole(
        id,
        actorId,
        body.userId,
        body.role,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "removeOrganizationMember",
    { preHandler: csrfProtect, config: { rateLimit: ORG_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireAuth(request)
      const { id, userId } = parse(OrgMemberParamsSchema, request.params)
      const body = parse(RemoveOrganizationMemberRequestSchema, { id, userId })
      const payload: RemoveOrganizationMemberResponse = await service().removeMember(
        id,
        actorId,
        body.userId,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "applyOrganizationVerification",
    { preHandler: csrfProtect, config: { rateLimit: ORG_VERIFICATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(OrgIdParamsSchema, request.params)
      const body = parse(ApplyOrganizationVerificationRequestSchema, {
        ...(request.body as object),
        id,
      })
      const dto: GetOrganizationVerificationResponse = await service().applyVerification(
        id,
        userId,
        body,
      )
      reply.status(200).send(dto)
    },
  )

  route(app, "getOrganizationVerification", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(OrgIdParamsSchema, request.params)
    parse(GetOrganizationVerificationRequestSchema, { id })
    const dto: GetOrganizationVerificationResponse = await service().getVerification(id, userId)
    reply.status(200).send(dto)
  })
}
