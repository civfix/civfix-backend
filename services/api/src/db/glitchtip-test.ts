/**
 * `pnpm --filter @civfix/api glitchtip:test`: sends one event tagged `glitchtip-test` to the GLITCHTIP_DSN
 * in the environment, through the API's own init and scrubbing, so a founder can see on a real GlitchTip
 * project what the API would send. It carries a fake email, IP address and cookie where the SDK picks them
 * up; none of them may arrive. Without a DSN it sends nothing.
 */

import * as Sentry from "@sentry/node"
import {
  captureError,
  flushErrorReporting,
  initErrorReporting,
  type ErrorReportingOptions,
} from "../errors/glitchtip.js"
import { firstNonEmpty } from "../lib/text.js"
import { SERVICE_VERSION } from "../version.js"
import { runIfMain } from "./cli.js"

const TEST_TAG = "glitchtip-test"
const DEFAULT_ENVIRONMENT = "development"
const FAKE_EMAIL = "glitchtip-test@example.com"
const FAKE_IP_ADDRESS = "198.51.100.23"
const FAKE_COOKIE = "sid=glitchtip-test-cookie"
const FAKE_REQUEST_URL = "http://localhost/glitchtip-test"

export async function runGlitchtipTest(
  transport?: ErrorReportingOptions["transport"],
): Promise<void> {
  const dsn = firstNonEmpty(process.env.GLITCHTIP_DSN)
  if (dsn === undefined) {
    console.log("GLITCHTIP_DSN is not set, so nothing was sent.")
    return
  }
  const started = await initErrorReporting({
    dsn,
    environment: firstNonEmpty(process.env.NODE_ENV) ?? DEFAULT_ENVIRONMENT,
    release: SERVICE_VERSION,
    ...(transport ? { transport } : {}),
  })
  if (!started) throw new Error("error reporting did not start, so nothing was sent")
  Sentry.withScope((scope) => {
    scope.setTag(TEST_TAG, "true")
    scope.setUser({ email: FAKE_EMAIL, ip_address: FAKE_IP_ADDRESS })
    // Where the SDK's HTTP integration records an incoming request for the event's `request`.
    scope.setSDKProcessingMetadata({
      normalizedRequest: { method: "GET", url: FAKE_REQUEST_URL, headers: { cookie: FAKE_COOKIE } },
    })
    captureError(new Error("GlitchTip test event from civfix glitchtip:test"))
  })
  await flushErrorReporting()
  console.log(`Sent one event tagged ${TEST_TAG} to GLITCHTIP_DSN.`)
}

runIfMain(import.meta.url, "glitchtip:test", () => runGlitchtipTest())
