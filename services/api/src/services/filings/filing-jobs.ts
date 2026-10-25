import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"

export async function registerFilingJobs(
  _container: Container,
  _logger?: FastifyBaseLogger,
): Promise<void> {
  throw new Error("not implemented")
}
