import { describe, expect, it } from "vitest"
import type { CleanupMemberRole, HostCapability, OrganizationMemberRole } from "@civfix/shared"
import { HOST_CAPABILITY_VALUES } from "@civfix/shared"
import { can, hostCapabilities, NO_HOST_STANDING } from "@civfix/shared/host"
import {
  hasHostStanding,
  hostForbiddenCopy,
  isEventPubliclyVisible,
} from "../../../src/services/host/authz.js"

const EVENT_ROLES: (CleanupMemberRole | null)[] = [null, "organizer", "cohost", "staff", "member"]
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
    for (const capability of HOST_CAPABILITY_VALUES) {
      const paymentsOnly = capability === "manage_payments" || capability === "view_donations"
      expect(caps.has(capability), capability).toBe(!paymentsOnly)
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
    expect(owner.has("manage_payments")).toBe(true)
  })

  it("org admin gets the cohost set minus export, plus view_donations", () => {
    const admin = hostCapabilities({ eventRole: null, orgRole: "admin" })
    expect(admin.has("export")).toBe(false)
    expect(admin.has("manage_event")).toBe(true)
    expect(admin.has("view_donations")).toBe(true)
    expect(admin.has("manage_payments")).toBe(false)
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
