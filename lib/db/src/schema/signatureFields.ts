import { pgTable, text, timestamp, integer, real } from "drizzle-orm/pg-core";

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
});

export type SignatureField = typeof signatureFieldsTable.$inferSelect;
