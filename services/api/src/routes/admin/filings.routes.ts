import type { Storage } from "@civfix/seams"
import type { AdminReportRepository } from "../../services/admin/admin-report-repository.js"
import type { JurisdictionContactsRepository } from "../../services/admin/jurisdiction-contacts-repository.js"
import type { FilingRepository } from "../../services/filings/filing-repository.js"
import type { FilingService } from "../../services/filings/filing-service.js"

export interface FilingRouteOverrides {
  filings: FilingRepository
  reports: Pick<AdminReportRepository, "getReport" | "getRouting">
  jurisdictions: Pick<JurisdictionContactsRepository, "jurisdictionExists">
  service: FilingService
  storage: Pick<Storage, "presignGet">
  automaticFiling: boolean
}

declare module "fastify" {
  interface FastifyInstance {
    filingOverrides?: FilingRouteOverrides
  }
}
