export const LOCAL_WEB_PORT = 3000
export const DEFAULT_API_PORT = 8080

export interface BaseUrlEnv {
  NODE_ENV?: string
  PORT?: number
  WEB_ORIGINS?: readonly string[]
  PUBLIC_API_URL?: string
}

/**
 * A missing origin must never resolve to a production host: a dev or test runtime would otherwise mail
 * real people links (and dev-signed unsubscribe tokens) that point at production. loadEnv refuses to
 * boot production without both values, so the production branch only guards that invariant.
 */
function baseUrlOr(
  configured: string | undefined,
  variable: string,
  env: BaseUrlEnv,
  port: number,
): string {
  const trimmed = (configured ?? "").trim().replace(/\/+$/, "")
  if (trimmed.length > 0) return trimmed
  if (env.NODE_ENV === "production") throw new Error(`${variable} is required in production`)
  return `http://localhost:${port}`
}

export function webBaseUrlOf(env: BaseUrlEnv): string {
  return baseUrlOr(env.WEB_ORIGINS?.[0], "WEB_ORIGINS", env, LOCAL_WEB_PORT)
}

export function apiBaseUrlOf(env: BaseUrlEnv): string {
  return baseUrlOr(env.PUBLIC_API_URL, "PUBLIC_API_URL", env, env.PORT ?? DEFAULT_API_PORT)
}
