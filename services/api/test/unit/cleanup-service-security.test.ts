import { describe, expect, it } from "vitest"
import type { CreateCleanupRequest } from "@civfix/shared"
import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import {
  makeCleanupService,
  RESOURCE_REQUEST_PER_HOST_PER_DAY,
  RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR,
  type CleanupService,
} from "../../src/services/cleanup-service.js"

const GEOID = "0644000"
const GREEDY_HOST = "11111111-1111-1111-1111-111111111111"
const NEIGHBOR_HOST = "22222222-2222-2222-2222-222222222222"

type OutboundMail = NonNullable<Parameters<typeof makeCleanupService>[0]["outboundMail"]>

function eventInput(organizationId: string): CreateCleanupRequest {
  return {
    title: "Park Cleanup",
    type: "site",
    eventKind: "cleanup",
    lat: 34.0,
    lng: -118.49,
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    organizationId,
    slots: [{ title: "Volunteers" }],
  }
}

function harness() {
  const repo = new InMemoryCleanupRepository()
  const organization = repo.seedOrganization({ name: "Ballona Creek Trust" })
  for (const [id, handle] of [
    [GREEDY_HOST, "greedy"],
    [NEIGHBOR_HOST, "neighbor"],
  ] as const) {
    repo.seedUser({ id, displayName: handle, handle })
    repo.seedOrgMember(organization.id, id, "member")
  }
  repo.jurisdictionContacts.set(GEOID, { contact: "events@lacity.gov", name: "City of LA" })

  const sent: string[] = []
  const outboundMail = {
    sendEventToJurisdiction: (input: { cleanupId: string }) => {
      sent.push(input.cleanupId)
      return Promise.resolve({ thread: { id: "thread-1" }, messageId: "<out-1@civfix.org>" })
    },
  } as unknown as OutboundMail

  const svc = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
    outboundMail,
  })
  const creator = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: { incr: () => Promise.resolve(1), incrBy: () => Promise.resolve(1) },
  })

  async function eventHostedBy(hostId: string): Promise<string> {
    const dto = await creator.createCleanup(eventInput(organization.id), hostId)
    const stored = repo.cleanups.get(dto.id)
    if (stored) stored.jurisdictionGeoid = GEOID
    return dto.id
  }

  return { svc: svc as CleanupService, sent, eventHostedBy }
}

describe("resource request budgets", () => {
  it("a host already over its daily cap does not spend the jurisdiction's hourly budget", async () => {
    const { svc, sent, eventHostedBy } = harness()
    const greedyEvent = await eventHostedBy(GREEDY_HOST)

    for (let i = 0; i < RESOURCE_REQUEST_PER_HOST_PER_DAY; i += 1) {
      await svc.requestResources({
        cleanupId: greedyEvent,
        message: "Need bags.",
        actorId: GREEDY_HOST,
      })
    }
    for (let i = 0; i < RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR; i += 1) {
      await expect(
        svc.requestResources({ cleanupId: greedyEvent, message: "Again.", actorId: GREEDY_HOST }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    }
    expect(sent).toHaveLength(RESOURCE_REQUEST_PER_HOST_PER_DAY)

    const neighborEvent = await eventHostedBy(NEIGHBOR_HOST)
    await expect(
      svc.requestResources({
        cleanupId: neighborEvent,
        message: "Need a dumpster.",
        actorId: NEIGHBOR_HOST,
      }),
    ).resolves.toEqual({ ok: true })
    expect(sent).toHaveLength(RESOURCE_REQUEST_PER_HOST_PER_DAY + 1)
  })
})
