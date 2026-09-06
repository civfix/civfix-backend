import type { EligibilityService } from "./eligibility-service.js"
import { normalizeEin } from "./eligibility-sources.js"

export interface NonprofitVerifiedEvent {
  organizationId: string
  ein: string | null
  operatorId: string
}

export interface EligibilityBootstrapDeps {
  eligibility: EligibilityService
  logger?: { warn: (obj: unknown, msg?: string) => void }
}

export interface EligibilityBootstrap {
  onNonprofitVerified(event: NonprofitVerifiedEvent): Promise<void>
}

export function makeEligibilityBootstrap(deps: EligibilityBootstrapDeps): EligibilityBootstrap {
  return {
    async onNonprofitVerified(event) {
      const ein = event.ein === null ? null : normalizeEin(event.ein)
      if (ein === null) {
        deps.logger?.warn(
          { evt: "eligibility.bootstrap.no_ein", organizationId: event.organizationId },
          "verified nonprofit has no usable EIN on its application; an operator must set one before it can be screened",
        )
        return
      }
      await deps.eligibility.requestEvaluation(event.organizationId)
    },
  }
}
