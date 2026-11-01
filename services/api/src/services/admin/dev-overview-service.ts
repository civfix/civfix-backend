import { isDeepStrictEqual } from "node:util"
import { DEFAULT_FEED_RANKING, type AdminDevOverviewResponse } from "@civfix/contract"
import { FAKE_SEAM_FLAGS } from "../../env.js"
import type { Env } from "../../env.js"
import type { DevJobsService } from "./dev-jobs-service.js"
import { WORKER_QUEUE_NAMES } from "./dev-jobs-service.js"

const UNSET_SERVICE_VERSION = "0.0.0"
const FAKE_FLAG_PREFIX = "USE_FAKE_"

type OverviewEnv = Pick<
  Env,
  | "environment"
  | "devToolsEnabled"
  | "DEV_TEST_EMAILS"
  | "CIVFIX_RELEASE_REF"
  | "CIVFIX_API_IMAGE_REF"
  | "CIVFIX_WORKER_IMAGE_REF"
  | "SMS_GUEST_ENABLED"
  | "SMS_DAILY_CAP"
  | "FEED_RANKING"
  | "FEED_AUTHOR_BOOSTS"
  | "REVIEWER_OTP_BYPASS"
  | "OAUTH_REQUIRE_NONCE"
  | "WS_ALLOW_QUERY_TOKEN"
  | (typeof FAKE_SEAM_FLAGS)[number]["flag"]
>

export interface DevOverviewServiceDeps {
  env: OverviewEnv
  /** The deploy's SERVICE_VERSION (the commit), "0.0.0" when it set none. */
  serviceVersion: string
  startedAt: Date
  contractVersion: string
  nodeVersion: string
  jobs: Pick<DevJobsService, "view">
}

export interface DevOverviewService {
  overview(): Promise<AdminDevOverviewResponse>
}

function onOff(value: boolean): string {
  return value ? "on" : "off"
}

/**
 * Only the env-only settings, each summarized: no secret, code, key, account id or credentialed URL
 * may reach this list, so nothing here passes a raw env value through except a number.
 */
function settings(env: OverviewEnv): AdminDevOverviewResponse["settings"] {
  return [
    { key: "SMS_GUEST_ENABLED", value: onOff(env.SMS_GUEST_ENABLED) },
    { key: "SMS_DAILY_CAP", value: String(env.SMS_DAILY_CAP) },
    {
      key: "FEED_RANKING",
      value: isDeepStrictEqual(env.FEED_RANKING, DEFAULT_FEED_RANKING) ? "Default" : "Custom",
    },
    { key: "FEED_AUTHOR_BOOSTS", value: `${env.FEED_AUTHOR_BOOSTS.size} accounts` },
    { key: "REVIEWER_OTP_BYPASS", value: onOff(env.REVIEWER_OTP_BYPASS) },
    { key: "OAUTH_REQUIRE_NONCE", value: onOff(env.OAUTH_REQUIRE_NONCE) },
    { key: "WS_ALLOW_QUERY_TOKEN", value: onOff(env.WS_ALLOW_QUERY_TOKEN) },
  ]
}

// The worker has no HTTP or Redis to ask; its newest job completion is what shows it is alive.
async function lastWorkerCompletion(jobs: Pick<DevJobsService, "view">): Promise<string | null> {
  const { queues } = await jobs.view()
  let newest: string | null = null
  for (const queue of queues) {
    if (!WORKER_QUEUE_NAMES.has(queue.name) || queue.lastCompletedAt === null) continue
    if (newest === null || Date.parse(queue.lastCompletedAt) > Date.parse(newest)) {
      newest = queue.lastCompletedAt
    }
  }
  return newest
}

export function makeDevOverviewService(deps: DevOverviewServiceDeps): DevOverviewService {
  const { env } = deps
  return {
    async overview(): Promise<AdminDevOverviewResponse> {
      return {
        environment: env.environment,
        devToolsEnabled: env.devToolsEnabled,
        api: {
          commit: deps.serviceVersion === UNSET_SERVICE_VERSION ? null : deps.serviceVersion,
          releaseRef: env.CIVFIX_RELEASE_REF ?? null,
          image: env.CIVFIX_API_IMAGE_REF ?? null,
          startedAt: deps.startedAt.toISOString(),
          contractVersion: deps.contractVersion,
          nodeVersion: deps.nodeVersion,
        },
        worker: {
          image: env.CIVFIX_WORKER_IMAGE_REF ?? null,
          lastJobCompletedAt: await lastWorkerCompletion(deps.jobs),
        },
        seams: FAKE_SEAM_FLAGS.map(({ flag }) => ({
          name: flag.slice(FAKE_FLAG_PREFIX.length).toLowerCase(),
          mode: env[flag] ? "fake" : "real",
        })),
        settings: settings(env),
        testAccounts: env.devToolsEnabled ? [...env.DEV_TEST_EMAILS] : [],
      }
    },
  }
}
