import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import type { FilingService } from "./filing-service.js"

export function makeContainerFilingService(
  _container: Container,
  _logger?: FastifyBaseLogger,
): FilingService {
  throw new Error("not implemented")
}
