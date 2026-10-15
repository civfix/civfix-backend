import { AppError } from "@civfix/shared"
import type { CounterStore } from "../../abuse/counter-store.js"

export interface CounterBudget {
  key: string
  windowSeconds: number
  cap: number
  unavailableLog: string
  unavailableMessage: string
  exceededMessage: string
}

/** Fails closed: an unreachable counter store refuses the action rather than lifting the cap. */
export async function reserveCounterBudget(
  counters: CounterStore | undefined,
  budget: CounterBudget,
  logger?: { warn(obj: unknown, msg?: string): void },
): Promise<void> {
  if (counters === undefined) return
  let used: number
  try {
    used = await counters.incr(budget.key, budget.windowSeconds)
  } catch (err) {
    logger?.warn({ err }, budget.unavailableLog)
    throw AppError.rateLimited(budget.unavailableMessage)
  }
  if (used > budget.cap) throw AppError.rateLimited(budget.exceededMessage)
}
