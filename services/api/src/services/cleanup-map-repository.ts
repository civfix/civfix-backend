import type { CleanupPinDTO } from "@civfix/shared"
import type { CleanupBBox } from "./cleanup-repository.js"

export interface CleanupMapRepository {
  listCleanupPins(
    bbox: CleanupBBox,
    when: "upcoming" | "past" | undefined,
  ): Promise<CleanupPinDTO[]>
}
