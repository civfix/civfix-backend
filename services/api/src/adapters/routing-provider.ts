/**
 * RoutingProvider adapter — Phase-2 PLACEHOLDER (route matrix + optimization for gov collection routes).
 *
 * TODO(phase-2): wire a real routing engine (self-hosted OSRM/Valhalla over HTTP). Until then every
 * method rejects with NOT_IMPL. Nothing consumes `container.routingProvider` today; the di.ts wiring that
 * selected this in production has been removed, so a stray call can't surface a prod 500 — but the seam +
 * this scaffold are retained so Phase 2 has a home. Keep the routing-engine client confined to this file.
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
