import { describe, expect, it } from "vitest"
import type { Container } from "../../src/di.js"
import type { Queryable } from "../../src/db/client.js"
import {
  apiBaseUrlOf,
  auditBestEffort,
  broadcastConfigOf,
  webBaseUrlOf,
} from "../../src/services/host/comms-wiring.js"

const LOCAL_API_PORT = 8181

function containerWith(env: Record<string, unknown>): Container {
  return { env } as unknown as Container
}

describe("broadcast base URLs never fall back to a production host", () => {
  it("links an unconfigured dev or test runtime to localhost", () => {
    const config = broadcastConfigOf(
      containerWith({
        NODE_ENV: "development",
        PORT: LOCAL_API_PORT,
        WEB_ORIGINS: [],
        PUBLIC_API_URL: "",
      }),
    )

    expect(config.webBaseUrl).toBe("http://localhost:3000")
    expect(config.apiBaseUrl).toBe(`http://localhost:${LOCAL_API_PORT}`)
  })

  it("uses the configured origins, trimmed of trailing slashes", () => {
    const env = {
      NODE_ENV: "production",
      PORT: 8080,
      WEB_ORIGINS: ["https://civfix.dev/", "https://other.example"],
      PUBLIC_API_URL: " https://api.civfix.dev// ",
    }

    expect(webBaseUrlOf(env)).toBe("https://civfix.dev")
    expect(apiBaseUrlOf(env)).toBe("https://api.civfix.dev")
  })

  it("refuses to invent a base URL in production instead of guessing one", () => {
    const env = { NODE_ENV: "production", PORT: 8080, WEB_ORIGINS: [], PUBLIC_API_URL: "" }

    expect(() => webBaseUrlOf(env)).toThrow(/WEB_ORIGINS/)
    expect(() => apiBaseUrlOf(env)).toThrow(/PUBLIC_API_URL/)
  })
})

describe("best-effort route audit", () => {
  it("logs the lost row at warn with its action and target instead of dropping it silently", async () => {
    const warnings: Array<{ obj: Record<string, unknown>; msg: string | undefined }> = []
    const failing = Object.assign(() => Promise.reject(new Error("audit_log unavailable")), {
      json: (value: unknown) => value,
    }) as unknown as Queryable

    await expect(
      auditBestEffort(
        failing,
        {
          action: "event.broadcast_sent",
          actorId: "00000000-0000-0000-0000-0000000000aa",
          target: "broadcast:00000000-0000-0000-0000-0000000000b1",
          meta: {},
        },
        {
          warn: (obj: unknown, msg?: string) => {
            warnings.push({ obj: obj as Record<string, unknown>, msg })
          },
        },
      ),
    ).resolves.toBeUndefined()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.obj).toMatchObject({
      action: "event.broadcast_sent",
      target: "broadcast:00000000-0000-0000-0000-0000000000b1",
    })
  })
})
