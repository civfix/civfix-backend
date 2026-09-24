export interface FederalLand {
  geoid: string
  name: string
  layer: "federal" | "tribal"
  agency: string
  population: number
  contactEmails: string[]
  reportFormUrl: string | null
  bbox: [number, number, number, number]
}

export const FEDERAL_LANDS: readonly FederalLand[] = [
  {
    geoid: "NPS-YELL",
    name: "Yellowstone National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    contactEmails: ["superintendent@example.nps.gov"],
    reportFormUrl: null,
    bbox: [-111.06, 44.13, -109.99, 45.1],
  },
  {
    geoid: "NPS-YOSE",
    name: "Yosemite National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    contactEmails: ["info@example.nps.gov"],
    reportFormUrl: null,
    bbox: [-119.89, 37.49, -119.2, 38.19],
  },
  {
    geoid: "NPS-GRCA",
    name: "Grand Canyon National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    contactEmails: [],
    reportFormUrl: null,
    bbox: [-114.3, 35.97, -111.8, 36.6],
  },
  {
    geoid: "NPS-JOTR",
    name: "Joshua Tree National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    contactEmails: [],
    reportFormUrl: null,
    bbox: [-116.3, 33.66, -115.45, 34.1],
  },
  {
    geoid: "USFS-ANGELES",
    name: "Angeles National Forest",
    layer: "federal",
    agency: "US Forest Service",
    population: 0,
    contactEmails: ["so@example.fs.usda.gov"],
    reportFormUrl: null,
    bbox: [-118.5, 34.16, -117.65, 34.51],
  },
  {
    geoid: "BIA-NAVAJO",
    name: "Navajo Nation",
    layer: "tribal",
    agency: "Navajo Nation / Bureau of Indian Affairs",
    population: 170_000,
    contactEmails: ["info@example.navajo-nsn.gov"],
    reportFormUrl: null,
    bbox: [-111.5, 35.3, -108.0, 37.1],
  },
] as const

const OCTAGON_CLIP = 0.18

export function federalLandGeoJson(bbox: readonly [number, number, number, number]): string {
  const [x0, y0, x1, y1] = bbox
  const fw = OCTAGON_CLIP * (x1 - x0)
  const fh = OCTAGON_CLIP * (y1 - y0)
  const ring: [number, number][] = [
    [x0 + fw, y1],
    [x1 - fw, y1],
    [x1, y1 - fh],
    [x1, y0 + fh],
    [x1 - fw, y0],
    [x0 + fw, y0],
    [x0, y0 + fh],
    [x0, y1 - fh],
    [x0 + fw, y1],
  ]
  return JSON.stringify({ type: "Polygon", coordinates: [ring] })
}

export function federalLandCenter(bbox: readonly [number, number, number, number]): {
  lng: number
  lat: number
} {
  const [x0, y0, x1, y1] = bbox
  return { lng: (x0 + x1) / 2, lat: (y0 + y1) / 2 }
}

export interface FederalProbe {
  name: string
  lng: number
  lat: number
  expectGeoid: string
}

export const FEDERAL_PROBES: readonly FederalProbe[] = FEDERAL_LANDS.map((land) => {
  const c = federalLandCenter(land.bbox)
  return { name: `inside_${land.geoid}`, lng: c.lng, lat: c.lat, expectGeoid: land.geoid }
})

export const PROBE_ANGELES_OVER_CITY: FederalProbe = {
  name: "angeles_over_city",
  lng: -118.3,
  lat: 34.18,
  expectGeoid: "USFS-ANGELES",
}
