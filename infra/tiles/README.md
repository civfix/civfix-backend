# Map tiles (PMTiles)

The civfix map uses a single [PMTiles](https://github.com/protomaps/PMTiles) archive served over
HTTP(S) with range requests. `TILES_PMTILES_URL` (an [OPT] env var) points the app/web at it. This
step does NOT build any tiles; this README documents how to make a small local one for dev.

## Build a small dev .pmtiles

1. Install the Protomaps tooling:

   - `pmtiles` CLI: https://github.com/protomaps/go-pmtiles/releases
   - (optional) `tippecanoe` if generating from GeoJSON: https://github.com/felt/tippecanoe

2. Extract a small bounding box from the public Protomaps basemap build (replace the bbox with your
   metro area):

   ```
   pmtiles extract https://build.protomaps.com/20240101.pmtiles dev.pmtiles \
     --bbox=-122.55,37.70,-122.35,37.83
   ```

   This downloads ONLY the tiles inside the bbox via range requests, producing a small archive.

3. Serve it for local dev (any static server with range support works):

   ```
   pmtiles serve . --port 8081
   # dev.pmtiles is now at http://localhost:8081/dev.pmtiles
   ```

4. Point the app at it:

   ```
   export TILES_PMTILES_URL=http://localhost:8081/dev.pmtiles
   ```

## Production

In production, host the full `.pmtiles` on R2 (or any range-request-capable origin) and set
`TILES_PMTILES_URL` to its public URL. `R2_PUBLIC_BASE` may be used to construct that URL.
