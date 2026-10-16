import type { LatLng } from "@civfix/contract"

/**
 * Route matrix + optimization for gov cleanup/collection routes.
 */

export interface RouteStop {
  id: string
  point: LatLng
  /** Optional service time at the stop, in seconds. */
  serviceSec?: number
}

export interface RouteOpts {
  /** Index into `stops` to start from; defaults to 0 if omitted by the impl. */
  startIndex?: number
  /** Index into `stops` to end at; defaults to open route. */
  endIndex?: number
  roundTrip?: boolean
}

export interface RouteLeg {
  fromStopId: string
  toStopId: string
  distanceMeters: number
  durationSec: number
}

export interface Route {
  /** Visit order as indices into the input `stops` array. */
  order: number[]
  legs: RouteLeg[]
  totalDistanceMeters: number
  totalDurationSec: number
}

export interface RoutingProvider {
  /** Pairwise duration matrix (seconds) for the given points. */
  matrix(points: LatLng[]): Promise<number[][]>
  optimize(stops: RouteStop[], opts: RouteOpts): Promise<Route>
}
