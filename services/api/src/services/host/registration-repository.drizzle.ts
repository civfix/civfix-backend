import type { Sql } from "../../db/client.js"
import { eventContextIn } from "./registration-load.drizzle.js"
import { makeTicketTypeMethods } from "./registration-ticket-types.drizzle.js"
import { makeQuestionMethods } from "./registration-questions.drizzle.js"
import { makeRegisterMethods } from "./registration-register.drizzle.js"
import { makeRosterMethods } from "./registration-roster.drizzle.js"
import { makeWaitlistMethods } from "./registration-waitlist.drizzle.js"
import { makeCheckinMethods } from "./registration-checkin.drizzle.js"
import { makePageMethods } from "./registration-pages.drizzle.js"
import type {
  EventRegistrationContext,
  HostRegistrationRepository,
} from "./registration-repository.types.js"

export { REGISTER_IDEMPOTENCY_SCOPE } from "./registration-register.drizzle.js"
export { applyBanIn } from "./registration-roster.drizzle.js"
export { cancelWaitlistEntriesIn } from "./registration-waitlist.drizzle.js"

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
