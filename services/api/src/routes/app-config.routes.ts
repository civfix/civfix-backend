import type { AppConfigResponse } from "@civfix/contract"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { route } from "../versioning/route.js"

const ANDROID_STORE_URL = "https://play.google.com/store/apps/details?id=org.civfix.community"

const APP_CONFIG_CACHE_SECONDS = 60
const FORCED_MIN_APP_VERSION = "999.0.0"

// With dev tools off the answer ignores who is asking, so a shared cache may hold it. With them on, a
// test account's force-update override makes it personal, so nothing may store it.
export async function registerAppConfigRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  route(app, "getAppConfig", async (request, reply) => {
    const flags = container.getRuntimeFlags()
    const [minIos, minAndroid, storeIos, text, level] = await Promise.all([
      flags.get("min_app_version_ios"),
      flags.get("min_app_version_android"),
      flags.get("app_store_url_ios"),
      flags.get("announcement_text"),
      flags.get("announcement_level"),
    ])
    const payload: AppConfigResponse = {
      minAppVersion: { ios: minIos, android: minAndroid },
      storeUrl: { ios: storeIos, android: ANDROID_STORE_URL },
      announcement: text === null ? null : { text, level },
    }
    if (!container.env.devToolsEnabled) {
      reply
        .header("cache-control", `public, max-age=${APP_CONFIG_CACHE_SECONDS}`)
        .status(200)
        .send(payload)
      return
    }
    const userId = request.auth?.userId ?? null
    if (userId !== null && (await container.getDevTestTools().hasForceUpdate(userId))) {
      payload.minAppVersion = { ios: FORCED_MIN_APP_VERSION, android: FORCED_MIN_APP_VERSION }
    }
    reply.header("cache-control", "no-store").status(200).send(payload)
  })
}
