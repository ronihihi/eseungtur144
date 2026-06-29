import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const documentsTable = pgTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  filename: text("filename").notNull(),
  filepath: text("filepath").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  uploaderName: text("uploader_name").notNull(),
  signingOrder: text("signing_order").notNull().default("simultaneous"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  sealedPdfPath: text("sealed_pdf_path"),
  sealedPdfHash: text("sealed_pdf_hash"),
  emailSubject: text("email_subject"),
  emailMessage: text("email_message"),
}, (t) => ({
  uploadedByCreatedAtIdx: index("documents_uploaded_by_created_at_idx").on(t.uploadedBy, t.createdAt),
}));

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({
  createdAt: true,
  completedAt: true,
  sealedPdfPath: true,
  sealedPdfHash: true,
});
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
