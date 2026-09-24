import type { Container } from "../di.js"
import { dropSuggestionsFor, type SuggestionsCache } from "./social-service.js"

export function makeContainerSuggestionsCache(container: Container): SuggestionsCache | undefined {
  if (!container.env.REDIS_URL) return undefined
  return {
    get: (key) => container.getCache().get(key),
    set: (key, value, ttl) => container.getCache().set(key, value, ttl),
    del: (key) => container.getCache().del(key),
  }
}

export async function dropContainerSuggestions(
  container: Container,
  viewerIds: readonly string[],
  logger?: { warn(obj: unknown, msg?: string): void },
): Promise<void> {
  await dropSuggestionsFor(makeContainerSuggestionsCache(container), viewerIds, logger)
}
