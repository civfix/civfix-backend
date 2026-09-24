/**
 * No routing engine exists yet, so every method rejects. That cannot surface as a production 500 because
 * nothing reads `container.routingProvider`; the stub keeps the seam wired for the gov collection-route
 * work. A real engine (self-hosted OSRM/Valhalla over HTTP) belongs here, with its client confined to
 * this file.
 */

import { AppError } from "@civfix/shared"
import type { RoutingProvider, RouteStop, RouteOpts, Route } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"

export interface RoutingProviderConfig {
  /** Base URL of the routing engine (OSRM/Valhalla-compatible). */
  baseUrl?: string
}

const NOT_IMPL = "adapter not implemented: routing-provider"

export class HttpRoutingProvider implements RoutingProvider {
  constructor(_config: RoutingProviderConfig = {}) {}

  matrix(_points: LatLng[]): Promise<number[][]> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  optimize(_stops: RouteStop[], _opts: RouteOpts): Promise<Route> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
