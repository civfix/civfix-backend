
import { accessSync, constants } from "node:fs"

export type MediaTool = "ffmpeg" | "ffprobe"

const ENV_VAR: Record<MediaTool, string> = {
  ffmpeg: "FFMPEG_PATH",
  ffprobe: "FFPROBE_PATH",
}

export interface MediaToolPaths {
  ffmpeg: string
  ffprobe: string
}

let cached: MediaToolPaths | null = null

export function resetMediaToolPaths(): void {
  cached = null
}

export async function mediaToolPath(tool: MediaTool): Promise<string> {
  cached ??= await resolveMediaToolPaths(process.env)
  return cached[tool]
}

export async function resolveMediaToolPaths(
  source: NodeJS.ProcessEnv = process.env,
): Promise<MediaToolPaths> {
  const [ffmpeg, ffprobe] = await Promise.all([
    resolveOne("ffmpeg", source),
    resolveOne("ffprobe", source),
  ])
  return { ffmpeg, ffprobe }
}

async function resolveOne(tool: MediaTool, source: NodeJS.ProcessEnv): Promise<string> {
  const key = ENV_VAR[tool]
  const configured = (source[key] ?? "").trim()

  if (configured) {
    assertExecutable(tool, key, configured)
    return configured
  }
  if (source.NODE_ENV === "production") {
    throw new Error(
      `media-worker: ${key} must be set in production and point at the pinned ${tool} binary the ` +
        "image installs. The npm static packages are development-only (ffprobe-static ships a 2018 " +
        "FFmpeg 4.0.2 with no security-patch channel) and are absent from the production image.",
    )
  }
  return vendoredPath(tool)
}

function assertExecutable(tool: MediaTool, key: string, path: string): void {
  try {
    accessSync(path, constants.X_OK)
  } catch (err) {
    throw new Error(
      `media-worker: ${key}="${path}" is not an executable file (${tool}): ${String(err)}`,
    )
  }
}

async function vendoredPath(tool: MediaTool): Promise<string> {
  if (tool === "ffprobe") {
    const mod = await import("ffprobe-static")
    const path =
      (mod.default as { path?: string } | undefined)?.path ?? (mod as { path?: string }).path
    if (!path) throw new Error("media-worker: ffprobe-static resolved no binary path")
    return path
  }
  const mod = await import("ffmpeg-static")
  const path = (mod.default ?? mod) as unknown as string | null
  if (!path) throw new Error("media-worker: ffmpeg-static resolved no binary path")
  return path
}
