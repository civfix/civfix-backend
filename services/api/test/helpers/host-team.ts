import type { CleanupDTO } from "@civfix/shared"

const FIXTURE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

export function fakeCleanupDTO(id: string = FIXTURE_ID): CleanupDTO {
  return {
    id,
    title: "Beach cleanup",
    type: "site",
    lat: 34.01,
    lng: -118.49,
    scheduledAt: "2026-10-01T17:00:00.000Z",
    status: "upcoming",
    organizer: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Olive Organizer",
      handle: "olive",
      followers: 0,
      following: 0,
      isFollowing: false,
    },
    going: 1,
    joined: true,
    bring: [],
    eventKind: "cleanup",
    address: null,
    visibility: "public",
    linkedReports: [],
    slots: [],
    galleryUrls: [],
    ticketTypes: [],
    myCapabilities: [],
  }
}

export function fakeCleanupReader(): (cleanupId: string) => Promise<CleanupDTO> {
  return (cleanupId: string) => Promise.resolve(fakeCleanupDTO(cleanupId))
}
