import type { Mailer } from "@civfix/shared/interfaces"
import { formatEventWhen } from "./host/broadcast-render.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./host/event-fields.js"
import type { GuestRsvpRepository } from "./guest-rsvp-service.js"

export function guestManageLinkBase(webOrigins: readonly string[]): string {
  const origin = webOrigins[0]
  return origin !== undefined && origin.length > 0
    ? origin.replace(/\/+$/, "")
    : "https://civfix.org"
}

export function guestEventLink(linkBase: string, cleanupId: string): string {
  return `${linkBase}/cleanups/${cleanupId}`
}

export interface GuestPromotionNotifier {
  notifyGuestPromoted(guestId: string): Promise<void>
}

export interface GuestNotifyDeps {
  repo: Pick<GuestRsvpRepository, "findGuestForNotice" | "findEvent">
  mailer: Mailer
  linkBase: string
}

export function makeGuestPromotionNotifier(deps: GuestNotifyDeps): GuestPromotionNotifier {
  return {
    async notifyGuestPromoted(guestId: string): Promise<void> {
      const guest = await deps.repo.findGuestForNotice(guestId)
      if (guest === null) return
      if (guest.cancelledAt !== null || guest.contactScrubbedAt !== null) return
      if (guest.email === null || guest.email.length === 0) return
      const event = await deps.repo.findEvent(guest.cleanupId)
      if (event === null) return
      await deps.mailer.sendTransactional(guest.email, "guest_promoted", {
        title: event.title,
        when: formatEventWhen(event.scheduledAt, event.timezone ?? DEFAULT_EVENT_TIME_ZONE),
        eventUrl: guestEventLink(deps.linkBase, guest.cleanupId),
      })
    },
  }
}
