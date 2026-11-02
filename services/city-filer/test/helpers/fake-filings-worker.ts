import { randomUUID } from "node:crypto"
import type { FilingRunPacket, FilingsWorker } from "@civfix/api/filings-worker"

export const PORTAL_HOST = "portal.test"

export interface FakeFiling {
  id: string
  status: "queued" | "running" | "done"
  attempts: number
  runId: string | null
  fileable: boolean
  packet: Omit<FilingRunPacket, "photos">
  media: { servedKey: string; byteSize: number; kind: "image" | "video" }[]
}

type FakeFilingInput = Partial<Omit<FakeFiling, "packet">> & {
  packet?: Partial<FakeFiling["packet"]>
}

/** The API's filings-worker reads and claim over rows in memory. */
export class FakeFilingsWorker implements FilingsWorker {
  paused = false
  readonly filings = new Map<string, FakeFiling>()
  /** Run ids the next claims hand out, in order; a fresh uuid once empty. */
  readonly nextRunIds: string[] = []

  add({ packet, ...over }: FakeFilingInput = {}): FakeFiling {
    const id = over.id ?? randomUUID()
    const filing: FakeFiling = {
      id,
      ...{ status: "queued", attempts: 0, runId: null, fileable: true, media: [] },
      ...over,
      packet: {
        filingId: id,
        ticketText: "Pothole on Main St\n\nReported by a resident via CivFix · ref LA-1",
        addr: "100 Main St, Los Angeles",
        lat: 34.05,
        lng: -118.25,
        category: "pothole",
        formUrl: `https://${PORTAL_HOST}/form`,
        portalHost: PORTAL_HOST,
        requestTypeHint: "Pothole",
        ...packet,
      },
    }
    this.filings.set(id, filing)
    return filing
  }

  async loadRunPacket(filingId: string) {
    const f = this.filings.get(filingId)
    if (f === undefined) return null
    // As the real query: ready images only, in report order, at most five.
    const images = f.media.filter((m) => m.kind === "image").slice(0, 5)
    return {
      ...f.packet,
      photos: images.map(({ servedKey, byteSize }) => ({ servedKey, byteSize })),
    }
  }

  async getFilingSettings() {
    return { paused: this.paused, updatedAt: new Date(0), updatedBy: null }
  }

  async claimFiling(filingId: string, attempt: number) {
    const f = this.filings.get(filingId)
    if (f?.status !== "queued" || f.attempts !== attempt - 1) return null
    Object.assign(f, {
      status: "running",
      attempts: attempt,
      runId: this.nextRunIds.shift() ?? randomUUID(),
    })
    return { runId: f.runId ?? "" }
  }

  async listRunningFilings() {
    const running = [...this.filings.values()].filter((f) => f.status === "running")
    return running.map((f) => ({ id: f.id, attempts: f.attempts, runId: f.runId }))
  }

  async isReportFileable(filingId: string) {
    return this.filings.get(filingId)?.fileable ?? false
  }
}
