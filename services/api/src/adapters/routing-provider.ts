/**
 * REAL RoutingProvider adapter: route matrix + optimization for gov collection routes (Phase 2).
 * Likely backed by an external routing engine (e.g. self-hosted OSRM/Valhalla) behind HTTP.
 *
 * SCAFFOLD: bodies throw until a later step wires the routing engine.
 *
 * Seam rule: the routing engine client is confined to this file.
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
  private readonly config: RoutingProviderConfig

  constructor(config: RoutingProviderConfig = {}) {
    this.config = config
  }

  matrix(_points: LatLng[]): Promise<number[][]> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  optimize(_stops: RouteStop[], _opts: RouteOpts): Promise<Route> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
