import type {
  RoutingProvider,
  RouteStop,
  RouteOpts,
  Route,
  RouteLeg,
} from "../interfaces/routing-provider.js"
import type { LatLng } from "@civfix/contract"
import { haversineMeters } from "@civfix/contract"

const WALK_SPEED_MPS = 1.4 // ~5 km/h

/**
 * In-memory RoutingProvider. matrix returns straight-line walking durations; optimize keeps the
 * input order (a trivial, deterministic route) and computes leg distances via haversine.
 */
export class FakeRoutingProvider implements RoutingProvider {
  matrix(points: LatLng[]): Promise<number[][]> {
    const m = points.map((a) =>
      points.map((b) => Math.round(haversineMeters(a, b) / WALK_SPEED_MPS)),
    )
    return Promise.resolve(m)
  }

  optimize(stops: RouteStop[], opts: RouteOpts): Promise<Route> {
    const order = stops.map((_, i) => i)
    const legs: RouteLeg[] = []
    let totalDistanceMeters = 0
    let totalDurationSec = 0

    for (let i = 0; i + 1 < stops.length; i++) {
      const from = stops[i]
      const to = stops[i + 1]
      if (!from || !to) continue
      const distanceMeters = Math.round(haversineMeters(from.point, to.point))
      const durationSec = Math.round(distanceMeters / WALK_SPEED_MPS) + (to.serviceSec ?? 0)
      legs.push({ fromStopId: from.id, toStopId: to.id, distanceMeters, durationSec })
      totalDistanceMeters += distanceMeters
      totalDurationSec += durationSec
    }

    if (opts.roundTrip && stops.length > 1) {
      const last = stops[stops.length - 1]
      const first = stops[0]
      if (last && first) {
        const distanceMeters = Math.round(haversineMeters(last.point, first.point))
        const durationSec = Math.round(distanceMeters / WALK_SPEED_MPS)
        legs.push({ fromStopId: last.id, toStopId: first.id, distanceMeters, durationSec })
        totalDistanceMeters += distanceMeters
        totalDurationSec += durationSec
      }
    }

    return Promise.resolve({ order, legs, totalDistanceMeters, totalDurationSec })
  }
}
