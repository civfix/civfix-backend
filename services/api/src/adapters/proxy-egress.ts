
export interface ProxySettings {
  url: string
  noProxy: string[]
}

export function readProxySettings(source: NodeJS.ProcessEnv = process.env): ProxySettings | null {
  const url = (source.HTTPS_PROXY ?? source.https_proxy ?? "").trim()
  if (url.length === 0) return null
  const noProxy = (source.NO_PROXY ?? source.no_proxy ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  return { url, noProxy }
}

export function shouldProxyHost(host: string, settings: ProxySettings): boolean {
  const target = host.toLowerCase()
  for (const entry of settings.noProxy) {
    if (entry === "*") return false
    const bare = entry.startsWith(".") ? entry.slice(1) : entry
    const name = bare.split(":")[0]
    if (name === undefined || name.length === 0) continue
    if (target === name || target.endsWith(`.${name}`)) return false
  }
  return true
}
