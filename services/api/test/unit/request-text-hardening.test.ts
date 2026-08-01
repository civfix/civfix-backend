import { afterEach, describe, expect, it } from "vitest"
import { AppError, type ChatMessageDTO } from "@civfix/shared"
import { randomUUID } from "node:crypto"
import type { ZodTypeAny } from "zod"
import { parse } from "../../src/routes/_validate.js"
import { handleClientFrame, type GatewayDeps, type GatewaySession } from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import {
  InMemoryChatRepository,
  InMemoryThreadsRepository,
  MockConnection,
} from "../helpers/chat.js"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import {
  CreateChatGroupBodySchema,
  UpdateChatGroupBodySchema,
} from "../../src/routes/chat-groups.routes.js"
import { CreatePollBodySchema, EditMessageBodySchema } from "../../src/routes/messages.routes.js"
import { EditDmMessageBodySchema } from "../../src/routes/dm.routes.js"
import {
  CancelCleanupBodySchema,
  CreateCleanupBodySchema,
  RequestEventResourcesBodySchema,
  UpdateCleanupBodySchema,
} from "../../src/routes/cleanups.routes.js"
import { CreateReportBodySchema } from "../../src/routes/reports.routes.js"
import { AnonReportBodySchema } from "../../src/routes/anon.routes.js"
import { MentionSearchQuerySchema } from "../../src/routes/users.routes.js"
import { SuggestPlacesBodySchema } from "../../src/routes/map.routes.js"
import {
  MARK_NOTIFICATIONS_READ_MAX_IDS,
  MarkNotificationsReadBodySchema,
} from "../../src/routes/notifications.routes.js"

const WHITESPACE = "   "
const ROOM_ID = "11111111-1111-4111-8111-111111111111"
const NEXT_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

function rejects(schema: ZodTypeAny, data: unknown, field: string): void {
  try {
    parse(schema, data)
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect(Object.keys((err as AppError).fields ?? {})).toContain(field)
    return
  }
  throw new Error(`expected a validation failure on "${field}"`)
}

function group(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Beach Crew", ...over }
}

function cleanup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Ocean Ave sweep",
    type: "site",
    lat: 34.01,
    lng: -118.49,
    scheduledAt: NEXT_WEEK,
    ...over,
  }
}

function poll(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roomKind: "group",
    roomId: ROOM_ID,
    question: "Which beach?",
    options: ["Venice", "Santa Monica"],
    ...over,
  }
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: randomUUID(),
    category: "trash",
    type: "dump",
    lat: 34.01,
    lng: -118.49,
    geomSource: "device",
    mediaUploadIds: [],
    ...over,
  }
}

describe("group name/description (CVX-002a, CVX-002d)", () => {
  it("rejects a whitespace-only name on create and on rename", () => {
    rejects(CreateChatGroupBodySchema, group({ name: WHITESPACE }), "name")
    rejects(UpdateChatGroupBodySchema, { id: ROOM_ID, name: WHITESPACE }, "name")
  })

  it("stores the trimmed name and description", () => {
    const body = parse(
      CreateChatGroupBodySchema,
      group({ name: "  Beach Crew  ", description: "  We meet Saturdays.  " }),
    )
    expect(body.name).toBe("Beach Crew")
    expect(body.description).toBe("We meet Saturdays.")
  })

  it("measures the length caps on the trimmed value, and still rejects an oversized name", () => {
    const padded = parse(CreateChatGroupBodySchema, group({ name: ` ${"x".repeat(80)} ` }))
    expect(padded.name).toHaveLength(80)
    rejects(CreateChatGroupBodySchema, group({ name: "x".repeat(81) }), "name")
  })

  it("keeps the strict() unknown-key rejection", () => {
    rejects(CreateChatGroupBodySchema, group({ smuggled: true }), "_")
  })
})

describe("message edit body (CVX-002b)", () => {
  const edit = { roomKind: "group", roomId: ROOM_ID, messageId: ROOM_ID }

  it("rejects a whitespace-only body on both edit routes", () => {
    rejects(EditMessageBodySchema, { ...edit, body: WHITESPACE }, "body")
    rejects(
      EditDmMessageBodySchema,
      { threadId: ROOM_ID, messageId: ROOM_ID, body: WHITESPACE },
      "body",
    )
  })

  it("stores the trimmed body", () => {
    expect(parse(EditMessageBodySchema, { ...edit, body: "  fixed the typo  " }).body).toBe(
      "fixed the typo",
    )
  })
})

describe("poll question and options (CVX-002c, CVX-009)", () => {
  it("rejects a whitespace-only question or option", () => {
    rejects(CreatePollBodySchema, poll({ question: WHITESPACE }), "question")
    rejects(CreatePollBodySchema, poll({ options: [WHITESPACE, "Santa Monica"] }), "options.0")
  })

  it("rejects duplicate options, including ones that differ only by surrounding whitespace", () => {
    rejects(CreatePollBodySchema, poll({ options: ["A", "A"] }), "options.1")
    rejects(CreatePollBodySchema, poll({ options: [" A", "A "] }), "options.1")
    rejects(CreatePollBodySchema, poll({ options: ["A", "B", "A"] }), "options.2")
  })

  it("accepts distinct options and stores them trimmed", () => {
    const body = parse(CreatePollBodySchema, poll({ options: [" Venice ", "Santa Monica"] }))
    expect(body.options).toEqual(["Venice", "Santa Monica"])
  })

  it("keeps the min-2 / max-10 caps green", () => {
    rejects(CreatePollBodySchema, poll({ options: ["only one"] }), "options")
    rejects(
      CreatePollBodySchema,
      poll({ options: Array.from({ length: 11 }, (_, i) => `option ${i}`) }),
      "options",
    )
  })
})

describe("cleanup title, description, spot label and bring list (CVX-002)", () => {
  it("rejects a whitespace-only title on create and on update", () => {
    rejects(CreateCleanupBodySchema, cleanup({ title: WHITESPACE }), "title")
    rejects(UpdateCleanupBodySchema, { title: WHITESPACE }, "title")
  })

  it("trims the description, the spot label and each bring item", () => {
    const body = parse(
      CreateCleanupBodySchema,
      cleanup({
        title: "  Ocean Ave sweep  ",
        description: "  Bring water.  ",
        address: "  Ocean Ave & Pico  ",
        bring: ["  gloves  ", "bags"],
      }),
    )
    expect(body.title).toBe("Ocean Ave sweep")
    expect(body.description).toBe("Bring water.")
    expect(body.address).toBe("Ocean Ave & Pico")
    expect(body.bring).toEqual(["gloves", "bags"])
  })

  it("drops bring entries that trim to nothing instead of persisting empty strings", () => {
    const created = parse(
      CreateCleanupBodySchema,
      cleanup({ bring: [WHITESPACE, "  gloves  ", ""] }),
    )
    expect(created.bring).toEqual(["gloves"])

    const updated = parse(UpdateCleanupBodySchema, { bring: [WHITESPACE] })
    expect(updated.bring).toEqual([])
  })

  it("leaves the scheduledAt bounds in force", () => {
    rejects(
      CreateCleanupBodySchema,
      cleanup({ scheduledAt: "1999-01-01T00:00:00.000Z" }),
      "scheduledAt",
    )
  })

  it("trims the cancel reason and rejects a blank resource-request message", () => {
    const cancel = parse(CancelCleanupBodySchema, { id: ROOM_ID, reason: "  rained out  " })
    expect(cancel.reason).toBe("rained out")
    rejects(RequestEventResourcesBodySchema, { id: ROOM_ID, message: WHITESPACE }, "message")
  })
})

describe("report free text (CVX-002)", () => {
  it("trims the optional title, description and address on the signed-in and anon routes", () => {
    const body = parse(
      CreateReportBodySchema,
      report({
        title: "  Couch on the curb  ",
        description: "  Blocking the sidewalk.  ",
        addr: "  1 Main St  ",
      }),
    )
    expect(body.title).toBe("Couch on the curb")
    expect(body.description).toBe("Blocking the sidewalk.")
    expect(body.addr).toBe("1 Main St")

    const anon = parse(
      AnonReportBodySchema,
      report({ turnstileToken: "tk", title: "  Couch on the curb  " }),
    )
    expect(anon.title).toBe("Couch on the curb")
  })

  it("does not trim the honeypot, so a whitespace-filled bot submission stays detectable", () => {
    expect(parse(CreateReportBodySchema, report({ honeypot: WHITESPACE })).honeypot).toBe(
      WHITESPACE,
    )
  })
})

describe("free-text search queries (CVX-002)", () => {
  it("rejects a whitespace-only mention query and trims a padded one", () => {
    rejects(MentionSearchQuerySchema, { q: WHITESPACE }, "q")
    expect(parse(MentionSearchQuerySchema, { q: "  @jane  " }).q).toBe("@jane")
  })

  it("rejects a whitespace-only place query and trims a padded one", () => {
    rejects(SuggestPlacesBodySchema, { q: WHITESPACE }, "q")
    expect(parse(SuggestPlacesBodySchema, { q: "  Ocean Ave  " }).q).toBe("Ocean Ave")
  })
})

describe("mark-notifications-read id cap (CVX-015)", () => {
  const ids = (count: number): string[] => Array.from({ length: count }, () => randomUUID())

  it("accepts a request at the cap", () => {
    const body = parse(MarkNotificationsReadBodySchema, {
      ids: ids(MARK_NOTIFICATIONS_READ_MAX_IDS),
    })
    expect(body.ids).toHaveLength(MARK_NOTIFICATIONS_READ_MAX_IDS)
  })

  it("rejects one id over the cap", () => {
    rejects(
      MarkNotificationsReadBodySchema,
      { ids: ids(MARK_NOTIFICATIONS_READ_MAX_IDS + 1) },
      "ids",
    )
  })

  it("still rejects a malformed id", () => {
    rejects(MarkNotificationsReadBodySchema, { ids: ["not-a-uuid"] }, "ids.0")
  })
})

describe("chat send over the WS gateway (CVX-002)", () => {
  const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const ALICE = "22222222-2222-4222-8222-222222222222"

  function gatewaySession(chat: WsChatService, conn: MockConnection): GatewaySession {
    const deps: GatewayDeps = { chat, isMember: () => Promise.resolve(true) }
    return {
      userId: ALICE,
      conn,
      joined: new Set<string>(),
      typingThrottle: new Map<string, number>(),
      deps,
    }
  }

  async function sendFrame(
    frame: Record<string, unknown>,
  ): Promise<{ conn: MockConnection; repo: InMemoryChatRepository }> {
    const repo = new InMemoryChatRepository()
    repo.registerSender({ id: ALICE, displayName: "Alice", handle: "alice", bio: null })
    const chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
    const conn = new MockConnection("A")
    const session = gatewaySession(chat, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(session, JSON.stringify({ type: "send", cleanupId: ROOM, ...frame }))
    return { conn, repo }
  }

  it("refuses a whitespace-only text frame with no attachment, and persists nothing", async () => {
    const { conn } = await sendFrame({ body: WHITESPACE, clientId: "c1" })
    expect(conn.framesOfType("ack")).toHaveLength(0)
    expect(conn.framesOfType("error").at(-1)).toMatchObject({ code: "BAD_FRAME" })
  })

  it("persists the trimmed body of a real message", async () => {
    const { conn } = await sendFrame({ body: "  hello there  ", clientId: "c2" })
    const ack = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(ack.message.body).toBe("hello there")
  })

  it("still accepts a body-less structured frame", async () => {
    const { conn } = await sendFrame({ body: "", clientId: "c3", kind: "share_pin" })
    expect(conn.framesOfType("error")).toHaveLength(0)
    expect(conn.framesOfType("ack")).toHaveLength(1)
  })
})

describe("PATCH /dm/:threadId/messages/:messageId over HTTP (CVX-002b)", () => {
  const PEER = "44444444-4444-4444-4444-444444444444"
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  async function harness(): Promise<{
    token: string
    threadId: string
    messageId: string
  }> {
    const env = loadEnv({ NODE_ENV: "test" })
    const mailer = new FakeMailer()
    const authServices = buildAuthServices({
      stores: makeInMemoryStores(),
      cache: new InMemoryCacheClient(() => Date.now()),
      mailer,
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const blocks = new InMemoryBlocksRepository()
    const dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
    dmRepo.registerUser({ id: PEER, displayName: "Peer", handle: "peer" })
    const chatOverrides: ChatGatewayOverrides = {
      isMember: () => Promise.resolve(true),
      threadsRepo: new InMemoryThreadsRepository(),
      dmRepo,
      chatRepo: new InMemoryChatRepository(),
      blocksRepo: blocks,
    }
    app = await buildServer({ env, authServices, chatOverrides })

    await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: "me@example.com" },
    })
    const verified = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email: "me@example.com", code: mailer.lastOtpFor("me@example.com")! },
    })
    const { token, user } = verified.json() as { token: string; user: { id: string } }
    dmRepo.registerUser({ id: user.id, displayName: "Me", handle: "me" })
    const thread = await dmRepo.openOrCreateThread(user.id, PEER)
    const message = await dmRepo.persist({ threadId: thread.id, senderId: user.id, body: "typo" })
    return { token, threadId: thread.id, messageId: message.id }
  }

  function edit(token: string, threadId: string, messageId: string, body: string) {
    return app!.inject({
      method: "PATCH",
      url: `/v1/dm/${threadId}/messages/${messageId}`,
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { body },
    })
  }

  it("422s a whitespace-only edit instead of blanking the bubble", async () => {
    const { token, threadId, messageId } = await harness()
    const res = await edit(token, threadId, messageId, WHITESPACE)
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("accepts a padded edit and stores it trimmed", async () => {
    const { token, threadId, messageId } = await harness()
    const res = await edit(token, threadId, messageId, "  fixed the typo  ")
    expect(res.statusCode).toBe(200)
    expect(res.json().body).toBe("fixed the typo")
  })
})
