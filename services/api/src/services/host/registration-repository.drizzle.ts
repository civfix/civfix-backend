import type { Sql } from "../../db/client.js"
import { eventContextIn } from "./registration-repository-load.drizzle.js"
import { makeTicketTypeMethods } from "./registration-repository-ticket-types.drizzle.js"
import { makeQuestionMethods } from "./registration-repository-questions.drizzle.js"
import { makeRegisterMethods } from "./registration-repository-register.drizzle.js"
import { makeRosterMethods } from "./registration-repository-roster.drizzle.js"
import { makeWaitlistMethods } from "./registration-repository-waitlist.drizzle.js"
import { makeCheckinMethods } from "./registration-repository-checkin.drizzle.js"
import { makePageMethods } from "./registration-repository-pages.drizzle.js"
import type {
  EventRegistrationContext,
  HostRegistrationRepository,
} from "./registration-repository.js"

export { REGISTER_IDEMPOTENCY_SCOPE } from "./registration-repository-register.drizzle.js"
export { applyBanIn } from "./registration-repository-roster.drizzle.js"

export function makeDrizzleHostRegistrationRepository(sql: Sql): HostRegistrationRepository {
  return {
    async eventContext(cleanupId: string): Promise<EventRegistrationContext | null> {
      return eventContextIn(sql, cleanupId)
    },
    ...makeTicketTypeMethods(sql),
    ...makeQuestionMethods(sql),
    ...makeRegisterMethods(sql),
    ...makeRosterMethods(sql),
    ...makeWaitlistMethods(sql),
    ...makeCheckinMethods(sql),
    ...makePageMethods(sql),
  }
}
