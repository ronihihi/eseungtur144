import { pgTable, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  password: text("password"), // nullable for Azure SSO users
  role: text("role").notNull().default("user"),
  provider: text("provider").notNull().default("local"), // 'local' | 'azure'
  azureId: text("azure_id").unique(),
  signatureData: text("signature_data"),
  emailVerified: boolean("email_verified").notNull().default(false),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  emailCiUniq: uniqueIndex("users_email_ci_uniq").on(sql`lower(${t.email})`),
}));

export const insertUserSchema = createInsertSchema(usersTable).omit({
  createdAt: true,
  mustChangePassword: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
