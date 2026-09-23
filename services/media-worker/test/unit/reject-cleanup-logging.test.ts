import { describe, expect, it } from "vitest"
import { deleteRejectedObjects, deleteSupersededUpload } from "../../src/jobs/reject-cleanup.js"

const R2_KEY = "uploads/2026/09/leak"

function deps() {
  const tombstones: { keys: string[] }[] = []
  return {
    tombstones,
    cleanup: {
      repo: {
        r2KeyReferencedByOthers: () => Promise.resolve(false),
        recordLeakedObjects: (input: { keys: string[] }) => {
          tombstones.push(input)
          return Promise.resolve()
        },
      },
      storage: { delete: () => Promise.reject(new Error("R2 403 AccessDenied")) },
    },
  }
}

function capture() {
  const lines: { line: string; extra?: Record<string, unknown> }[] = []
  return {
    lines,
    log: (line: string, extra?: Record<string, unknown>) => lines.push({ line, extra }),
  }
}

describe("storage delete failures keep their cause", () => {
  it("logs why the superseded upload could not be deleted before tombstoning it", async () => {
    const { tombstones, cleanup } = deps()
    const { lines, log } = capture()

    await deleteSupersededUpload({ id: "m1", r2Key: R2_KEY }, cleanup, log, () => {})

    expect(tombstones).toHaveLength(1)
    const cause = lines.find((l) => String(l.extra?.err).includes("AccessDenied"))
    expect(cause?.extra).toMatchObject({ mediaId: "m1", key: R2_KEY })
  })

  it("logs why each rejected-media object could not be deleted", async () => {
    const { tombstones, cleanup } = deps()
    const { lines, log } = capture()

    await deleteRejectedObjects(
      { id: "m2", r2Key: R2_KEY, servedKey: null, thumbKey: null },
      cleanup,
      log,
      () => {},
    )

    expect(tombstones[0]!.keys.length).toBeGreaterThan(0)
    const causes = lines.filter((l) => String(l.extra?.err).includes("AccessDenied"))
    expect(causes.map((l) => l.extra?.key)).toEqual(tombstones[0]!.keys)
  })
})
