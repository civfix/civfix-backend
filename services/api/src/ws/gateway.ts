/**
 * WebSocket chat gateway, mounted at GET /ws via @fastify/websocket. Split into focused modules; this
 * barrel preserves the public surface (chat.routes `roomKeyFor`/`registerChatGateway`/types,
 * discussion.routes `roomKeyFor`, and the unit tests' `resolveWsUser`/`isAllowedWsOrigin`/
 * `checkWsHandshake`/`handleClientFrame`/`subscribeUserChannel`). See ws/handshake.ts, ws/frame-handler.ts,
 * ws/socket-lifecycle.ts, ws/types.ts.
 *
 * ORIGIN ALLOWLIST (anti-CSWSH): the cookie handshake path is vulnerable to Cross-Site WebSocket Hijacking
 * because the browser attaches the httpOnly session cookie to a cross-origin ws() connection automatically
 * (the CORS preflight does NOT apply to WebSocket upgrades). So BEFORE resolving auth we check the upgrade
 * request's Origin against the configured WEB_ORIGINS allowlist. NO-ORIGIN HANDLING (P1-4): a handshake
 * with a session cookie REQUIRES a present, allowlisted Origin (a real browser always sends one, so a
 * missing Origin on the cookie path is a non-browser client replaying a stolen cookie — the CSWSH second
 * factor); a cookie-less handshake (native mobile ?ticket, server-to-server, tests) may omit Origin
 * because it carries no ambient cookie and the ticket/bearer path still validates the credential.
 *
 * DUAL HANDSHAKE AUTH: (a) COOKIE (web, same-origin SPA) — the httpOnly session cookie is sent
 * automatically on the upgrade, so the auth onRequest hook already resolved req.auth from it. (b)
 * ?ticket=<single-use, short-lived> (mobile) — a React Native WebSocket cannot set an Authorization
 * header, so the native client mints a connect ticket over authenticated HTTP and redeems it here. The
 * legacy ?token=<30-day session bearer> query param is DISABLED by default (H5: a full-privilege
 * credential in a URL leaks into every proxy/CDN/APM log) and only re-enabled by the temporary
 * WS_ALLOW_QUERY_TOKEN break-glass env flag; see ws/handshake.ts. A handshake that resolves to no user
 * is REJECTED (closed with a policy-violation code + one {type:"error"} frame), so unauthenticated
 * sockets never join. A LIVE socket is re-authorized on every heartbeat (M1, ws/socket-lifecycle.ts).
 *
 * MEMBERSHIP-GATED ROOMS: chat membership == cleanup membership. join/send verify the user is a
 * cleanup_member before the ChatService admits the socket or accepts a message. Inbound frames are
 * validated against WsClientMessageSchema; a malformed frame is answered with an error frame and never
 * crashes the socket. Outbound frames conform to WsServerMessageSchema.
 */

export * from "./types.js"
export * from "./handshake.js"
export * from "./frame-handler.js"
export * from "./socket-lifecycle.js"
