import { pgTable, text, timestamp, integer, real, index } from "drizzle-orm/pg-core";

export const signatureFieldsTable = pgTable("signature_fields", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  recipientId: text("recipient_id").notNull(),
  page: integer("page").notNull().default(1),
  x: real("x").notNull().default(0.1),
  y: real("y").notNull().default(0.85),
  width: real("width").notNull().default(0.3),
  height: real("height").notNull().default(0.07),
  fieldType: text("field_type").notNull().default("signature"),
  fieldValue: text("field_value"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  documentIdIdx: index("sig_fields_document_id_idx").on(t.documentId),
  recipientIdIdx: index("sig_fields_recipient_id_idx").on(t.recipientId),
}));

export type SignatureField = typeof signatureFieldsTable.$inferSelect;
