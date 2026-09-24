import { AppError } from "@civfix/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
  isBelowMinSupported,
  isServedVersion,
  isVersionSegment,
  validateVersionPolicy,
  versionStatus,
} from "./policy.js"

function firstPathSegment(url: string): string {
  const queryStart = url.indexOf("?")
  const path = queryStart === -1 ? url : url.slice(0, queryStart)
  for (const seg of path.split("/")) {
    if (seg.length > 0) return decodeSegment(seg)
  }
  return ""
}

function decodeSegment(seg: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(seg)
  } catch {
    return seg
  }
  const slash = decoded.indexOf("/")
  return slash === -1 ? decoded : decoded.slice(0, slash)
}

export async function registerVersionGate(app: FastifyInstance): Promise<void> {
  validateVersionPolicy()
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const seg = firstPathSegment(request.url)

    if (!isVersionSegment(seg)) return

    if (isBelowMinSupported(seg)) {
      throw AppError.unsupportedApiVersion()
    }

    const status = versionStatus(seg)
    if (status === null) {
      throw AppError.unsupportedApiVersion()
    }

    if (!isServedVersion(seg)) {
      throw status.status === "sunset"
        ? AppError.apiVersionSunset()
        : AppError.unsupportedApiVersion()
    }

    switch (status.status) {
      case "current":
        return
      case "deprecated":
        reply.header("Deprecation", "true")
        if (status.sunset) {
          const sunsetDate = new Date(status.sunset)
          if (!Number.isNaN(sunsetDate.getTime())) {
            reply.header("Sunset", sunsetDate.toUTCString())
          }
        }
        return
      case "sunset":
        throw AppError.apiVersionSunset()
      default: {
        const _exhaustive: never = status.status
        return _exhaustive
      }
    }
  })
}
