import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recipientsTable = pgTable("recipients", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  teamName: text("team_name").notNull(),
  email: text("email").notNull(),
  signOrder: integer("sign_order").notNull(),
  status: text("status").notNull().default("pending"),
  token: text("token").notNull().unique(),
  signerName: text("signer_name"),
  ipAddress: text("ip_address"),
  signatureData: text("signature_data"),
  viewedAt: timestamp("viewed_at"),
  signedAt: timestamp("signed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  requiresReview: boolean("requires_review").notNull().default(false),
  requiresSignature: boolean("requires_signature").notNull().default(true),
  reviewStatus: text("review_status"),
  reviewedAt: timestamp("reviewed_at"),
  reviewNote: text("review_note"),
  reviewChecklist: jsonb("review_checklist"),
  tokenExpiresAt: timestamp("token_expires_at"),
}, (t) => ({
  documentIdIdx: index("recipients_document_id_idx").on(t.documentId),
}));

export const insertRecipientSchema = createInsertSchema(recipientsTable).omit({
  createdAt: true,
  viewedAt: true,
  signedAt: true,
  signerName: true,
  ipAddress: true,
  signatureData: true,
  reviewedAt: true,
  reviewNote: true,
  reviewChecklist: true,
});
export type InsertRecipient = z.infer<typeof insertRecipientSchema>;
export type Recipient = typeof recipientsTable.$inferSelect;
