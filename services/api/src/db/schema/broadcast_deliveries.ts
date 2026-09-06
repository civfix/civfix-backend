import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { broadcasts } from "./broadcasts.js"
import { cleanupGuests } from "./cleanup_guests.js"
import { users } from "./users.js"
import type {
  BroadcastChannelValue,
  BroadcastRecipientKindValue,
  DeliveryFailureKindValue,
  DeliveryStatusValue,
  DeliverySuppressionReasonValue,
} from "./types-broadcast.js"

export const broadcastDeliveries = pgTable(
  "broadcast_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    chunkNo: integer("chunk_no").notNull().default(0),
    recipientKind: text("recipient_kind").$type<BroadcastRecipientKindValue>().notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    guestId: uuid("guest_id").references(() => cleanupGuests.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id").generatedAlwaysAs(sql`COALESCE(user_id, guest_id)`),
    channel: text("channel").$type<BroadcastChannelValue>().notNull(),
    status: text("status").$type<DeliveryStatusValue>().notNull().default("pending"),
    suppressionReason: text("suppression_reason").$type<DeliverySuppressionReasonValue>(),
    failureKind: text("failure_kind").$type<DeliveryFailureKindValue>(),
    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("broadcast_deliveries_recipient_uidx").on(
      t.broadcastId,
      t.channel,
      t.recipientKind,
      t.recipientId,
    ),
    index("broadcast_deliveries_pending_idx")
      .on(t.broadcastId, t.chunkNo)
      .where(sql`status IN ('pending','in_flight')`),
    index("broadcast_deliveries_rollup_idx").on(t.broadcastId, t.channel, t.status),
    index("broadcast_deliveries_created_idx").on(t.createdAt),
  ],
)

export type BroadcastDeliveryRow = typeof broadcastDeliveries.$inferSelect
export type NewBroadcastDeliveryRow = typeof broadcastDeliveries.$inferInsert
