# Location coarsening for public display — assessment & recommendation

**Audience:** internal (engineering + product + privacy counsel). Not served publicly.
**Last updated:** 2026-06-20 (privacy/backend-hardening).

Backs `documents/21-privacy-compliance.md` section 7.3 ("Location coarsening at
rest/display where precision isn't needed"), flagged P1 with a counsel/product
judgment marker.

## Assessment: do public report responses expose full precision? YES.

The backend stores report points as PostGIS `geom` (SRID 4326) and projects them
into the DTO at **full stored precision** on every PUBLIC surface:

| Surface | Code | Field |
|---|---|---|
| Public report detail (non-owner read) | `services/api/src/services/report-service.ts` `toReportDTO` | `lat: record.lat, lng: record.lng` |
| Map pins (browse) | same file, `toMapPinDTO` | `lat: pin.lat, lng: pin.lng` |
| Search results | same file, `searchReports` -> `toMapPinDTO` | same |

The owner's own detail/list (`mine: true`) and the create-time idempotency
snapshot also carry full precision; routing to a jurisdiction uses the precise
`geom`.

**A second stored copy exists as of migration 0172 (issue #100).** `posts.geom`
denormalises the linked report's or event's point onto the post row so the
ranked home feed's proximity pool is one bounded KNN scan. It is NOT a new
class of data and NOT a new exposure: the value is copied server-side from a
coordinate this platform already publishes at full precision on the linked
report or event, it is never populated from a client-supplied coordinate, and
it is never projected into any DTO — it only orders the feed, and the feed
emits `PostDTO`, which carries no post-level coordinate at all. The only
derived value that leaves the server is the ranking score.

Consequence for any future coarsening decision: rounding the projected
`lat`/`lng` would NOT cover `posts.geom`, which would keep ordering the feed at
full precision. That is almost certainly the desired behaviour (proximity
ranking is the point), but it must be a stated decision rather than an
oversight, and a policy that requires coarsening at REST — not just in
transit — has to cover this column, `reports.geom`, `cleanups.geom` and
`users.last_activity_geom` together.

## Is a backend-only coarsening possible without a shared-contract change?

**Technically yes.** `ReportDTO.lat/lng` and `ReportPinDTO.lat/lng` are
unconstrained `z.number()` in `@civfix/shared`, so rounding them server-side
before send is a pure display transform that needs NO contract change and NO
migration. The precise `geom` stays untouched for routing; only the projected
number is rounded.

It IS contained: a single `coarsen(lat, lng)` helper applied in `toMapPinDTO` and
in `toReportDTO` **only when `mine === false`** (owner keeps precise; the
create-snapshot is built with `mine:true` so it is unaffected), and NOT before
the `clusterByZoom` centroid math (cluster on precise points, round only the
emitted leaf pins).

## Why this was NOT implemented here (product/counsel DECISION)

Per the task's guard ("if it would require ... a product decision, do NOT
implement; write a recommendation"), and because the privacy doc flags this with a
counsel marker, the COARSENING RADIUS is a product decision, not an engineering
one:

- ~3 decimal places ≈ 110 m grid (hides the exact doorstep; still "this block").
- ~4 decimal places ≈ 11 m (barely hides anything).
- Snapping to an H3 cell centroid (the report already computes an H3 cell) is an
  alternative that yields uniform-size privacy cells.

Choosing the radius trades a reporter's location privacy against the civic
usefulness of the map (a pothole/graffiti pin that is off by 110 m may point at
the wrong property). That trade-off, plus whether to coarsen detail reads or only
the map, is a product + counsel call.

## Recommendation

1. **Decide a public-display precision** (product + counsel). Suggested default:
   round public-display coordinates to **3 decimal places (~110 m)** for the
   browse map + search, and keep the **report DETAIL** at full precision for the
   owner but coarsened for non-owners — OR snap to the existing H3 cell centroid
   for a uniform privacy cell.
2. **Implement as a backend-only transform** once the radius is chosen: a
   `coarsenForPublicDisplay(lat, lng)` helper applied in `toMapPinDTO` and in
   `toReportDTO` guarded by `!mine`. No shared-contract change, no migration.
   Cluster math stays on precise points; round only the emitted leaf pins.
3. **Keep `geom` precise** for jurisdiction routing and the owner's own views.
4. Reflect the chosen behavior in the public privacy policy ("we show approximate
   locations publicly").

This is a low-risk, contained follow-up that is intentionally gated on the product
decision above.
