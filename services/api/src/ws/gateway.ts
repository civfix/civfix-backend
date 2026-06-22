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
 * factor); a cookie-less handshake (native mobile ?token bearer, server-to-server, tests) may omit Origin
 * because it carries no ambient cookie and the bearer/?token path still validates the credential.
 *
 * DUAL HANDSHAKE AUTH: (a) COOKIE (web, same-origin SPA) — the httpOnly session cookie is sent
 * automatically on the upgrade, so the auth onRequest hook already resolved req.auth from it. (b)
 * ?token=<bearer> QUERY PARAM (mobile) — a React Native WebSocket cannot set an Authorization header, so
 * the native client passes its bearer as a query param, resolved via session-service during the handshake.
 * A handshake that resolves to no user is REJECTED (closed with a policy-violation code + one
 * {type:"error"} frame), so unauthenticated sockets never join.
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
