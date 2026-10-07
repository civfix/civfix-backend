// Query strings carry secrets (ticket access codes, anonymous claim codes, OAuth code/state), so every log
// line and error report records the path only.
export function loggedRequestUrl(url: string): string {
  return url.split("?")[0] ?? url
}
