/**
 * Origin allowlist (anti-CSWSH): the browser attaches the httpOnly session cookie to a cross-origin
 * WebSocket upgrade and CORS preflight does not apply, so the Origin is checked against WEB_ORIGINS
 * before auth resolves. A handshake carrying a session cookie REQUIRES an allowlisted Origin, since a
 * real browser always sends one and a missing Origin there means a non-browser client replaying a stolen
 * cookie. A cookie-less handshake (native ?ticket, server-to-server, tests) may omit Origin because it
 * carries no ambient credential and the ticket path still validates it.
 *
 * A React Native WebSocket cannot set an Authorization header, so mobile redeems a single-use,
 * short-lived ?ticket minted over authenticated HTTP. The legacy ?token= session bearer is off by default
 * because a full-privilege credential in a URL leaks into every proxy, CDN and APM log. A handshake that
 * resolves to no user is rejected, and a live socket is re-authorized on every heartbeat.
 *
 * Implemented in ws/handshake.ts (origin allowlist, ?ticket, the WS_ALLOW_QUERY_TOKEN break-glass for
 * ?token=), ws/socket-lifecycle.ts (heartbeat re-authorization) and ws/frame-handler.ts (per-room
 * membership checks in authorizeRoom).
 */

export * from "./types.js"
export * from "./handshake.js"
export * from "./frame-handler.js"
export * from "./socket-lifecycle.js"
