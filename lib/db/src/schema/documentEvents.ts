import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const documentEventsTable = pgTable("document_events", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  recipientId: text("recipient_id"),
  eventType: text("event_type").notNull(),
  actorName: text("actor_name"),
  actorEmail: text("actor_email"),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  documentIdIdx: index("doc_events_document_id_idx").on(t.documentId),
}));

export type DocumentEvent = typeof documentEventsTable.$inferSelect;
