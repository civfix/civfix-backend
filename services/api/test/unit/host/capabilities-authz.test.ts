import { describe, expect, it } from "vitest"
import type { CleanupMemberRole, HostCapability, OrganizationMemberRole } from "@civfix/shared"
import { HOST_CAPABILITY_VALUES } from "@civfix/shared"
import { can, hostCapabilities, NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import {
  assertMayGrantRole,
  hasHostStanding,
  hostForbiddenCopy,
  isEventPubliclyVisible,
} from "../../../src/services/host/authz.js"

const EVENT_ROLES: (CleanupMemberRole | null)[] = [
  null,
  "organizer",
  "cohost",
  "coordinator",
  "staff",
  "member",
]
const ORG_ROLES: (OrganizationMemberRole | null)[] = [null, "owner", "admin", "member"]

describe("host capability matrix (backend realm)", () => {
  it("covers every event-role x org-role combination without throwing", () => {
    for (const eventRole of EVENT_ROLES) {
      for (const orgRole of ORG_ROLES) {
        expect(() => hostCapabilities({ eventRole, orgRole })).not.toThrow()
      }
    }
  })

  it("organizer holds every event-lane capability", () => {
    const caps = hostCapabilities({ eventRole: "organizer", orgRole: null })
    const orgLaneOnly: HostCapability[] = [
      "manage_org_members",
    ]
    for (const capability of HOST_CAPABILITY_VALUES) {
      expect(caps.has(capability), capability).toBe(!orgLaneOnly.includes(capability))
    }
  })

  it("cohost is the organizer set minus the four organizer-only powers", () => {
    const organizerOnly: HostCapability[] = [
      "manage_team",
      "cancel_event",
      "manage_org_link",
      "request_resources",
    ]
    for (const capability of organizerOnly) {
      expect(can({ eventRole: "cohost", orgRole: null }, capability), capability).toBe(false)
    }
    expect(can({ eventRole: "cohost", orgRole: null }, "manage_event")).toBe(true)
    expect(can({ eventRole: "cohost", orgRole: null }, "moderate_chat")).toBe(true)
  })

  it("staff is exactly view_event_private + view_roster + check_in", () => {
    const staff = hostCapabilities({ eventRole: "staff", orgRole: null })
    expect([...staff].sort()).toEqual(["check_in", "view_event_private", "view_roster"])
    expect(can({ eventRole: "staff", orgRole: null }, "moderate_chat")).toBe(false)
    expect(can({ eventRole: "staff", orgRole: null }, "view_guest_contact")).toBe(false)
    expect(can({ eventRole: "staff", orgRole: null }, "view_answers")).toBe(false)
    expect(can({ eventRole: "staff", orgRole: null }, "broadcast")).toBe(false)
  })

  it("coordinator runs the day and changes nothing", () => {
    const coordinator = hostCapabilities({ eventRole: "coordinator", orgRole: null })
    expect([...coordinator].sort()).toEqual(
      [
        "broadcast",
        "check_in",
        "moderate_chat",
        "view_analytics",
        "view_answers",
        "view_event_private",
        "view_roster",
      ].sort(),
    )
    for (const capability of [
      "view_guest_contact",
      "export",
      "manage_event",
      "manage_tickets",
      "manage_page",
      "manage_team",
      "cancel_event",
      "manage_org_link",
      "request_resources",
    ] as HostCapability[]) {
      expect(can({ eventRole: "coordinator", orgRole: null }, capability), capability).toBe(false)
    }
  })

  it("coordinator sits strictly between staff and cohost", () => {
    const staff = hostCapabilities({ eventRole: "staff", orgRole: null })
    const coordinator = hostCapabilities({ eventRole: "coordinator", orgRole: null })
    const cohost = hostCapabilities({ eventRole: "cohost", orgRole: null })
    for (const capability of staff) expect(coordinator.has(capability), capability).toBe(true)
    for (const capability of coordinator) expect(cohost.has(capability), capability).toBe(true)
    expect(coordinator.size).toBeGreaterThan(staff.size)
    expect(coordinator.size).toBeLessThan(cohost.size)
  })

  it("plain member and no standing hold nothing", () => {
    expect(hostCapabilities({ eventRole: "member", orgRole: null }).size).toBe(0)
    expect(hostCapabilities(NO_HOST_STANDING).size).toBe(0)
    expect(hostCapabilities({ eventRole: null, orgRole: "member" }).size).toBe(0)
  })

  it("org standing is additive: an org owner holds the organizer set on the org's events", () => {
    const owner = hostCapabilities({ eventRole: null, orgRole: "owner" })
    expect(owner.has("manage_event")).toBe(true)
    expect(owner.has("manage_team")).toBe(true)
    expect(owner.has("cancel_event")).toBe(true)
    expect(owner.has("manage_org_members")).toBe(true)
  })

  it("org admin gets the cohost set minus export and manage_team, plus the org roster", () => {
    const admin = hostCapabilities({ eventRole: null, orgRole: "admin" })
    expect(admin.has("export")).toBe(false)
    expect(admin.has("manage_event")).toBe(true)
    expect(admin.has("manage_org_members")).toBe(true)
    expect(admin.has("manage_team")).toBe(false)
  })

  it("the org roster token never leaks the event-team token: an admin cannot seat a cohost", () => {
    const admin: HostStanding = { eventRole: null, orgRole: "admin" }
    expect(can(admin, "manage_team")).toBe(false)
    expect(() => assertMayGrantRole(admin, "cohost")).toThrow()
    expect(can({ eventRole: null, orgRole: "member" }, "manage_org_members")).toBe(false)
  })

  it("an event staffer who is also an org owner gets the union, not the smaller set", () => {
    expect(can({ eventRole: "staff", orgRole: "owner" }, "manage_team")).toBe(true)
    expect(can({ eventRole: "staff", orgRole: "owner" }, "check_in")).toBe(true)
  })

  it("the returned set is frozen and shared - a caller cannot widen anyone's powers", () => {
    const caps = hostCapabilities({ eventRole: "staff", orgRole: null })
    expect(() => (caps as Set<HostCapability>).add("manage_event")).toThrow()
  })
})

describe("authz helpers", () => {
  it("has forbidden copy for every capability", () => {
    for (const capability of HOST_CAPABILITY_VALUES) {
      expect(hostForbiddenCopy(capability).length, capability).toBeGreaterThan(0)
    }
  })

  it("public and unlisted events are reachable by link; private is not", () => {
    expect(isEventPubliclyVisible("public")).toBe(true)
    expect(isEventPubliclyVisible("unlisted")).toBe(true)
    expect(isEventPubliclyVisible("private")).toBe(false)
  })

  it("hasHostStanding is true for either lane", () => {
    expect(hasHostStanding(NO_HOST_STANDING)).toBe(false)
    expect(hasHostStanding({ eventRole: "member", orgRole: null })).toBe(true)
    expect(hasHostStanding({ eventRole: null, orgRole: "member" })).toBe(true)
  })
})
