import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { eq, desc, inArray } from "drizzle-orm";
import { db, usersTable, documentsTable, recipientsTable } from "@workspace/db";
import type { Request, Response } from "express";

const router: IRouter = Router();

// HARD-3: Re-read role from DB on each admin request so demotions apply immediately
// without waiting for session expiry.
async function requireAdmin(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const rows = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, req.session.userId))
      .limit(1);
    if (!rows[0] || rows[0].role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
  } catch {
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  next();
}

async function requireAuditAccess(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    res.status(403).json({ error: "Audit access required" });
    return;
  }
  try {
    const rows = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, req.session.userId))
      .limit(1);
    const role = rows[0]?.role;
    if (!role || (role !== "admin" && role !== "auditor")) {
      res.status(403).json({ error: "Audit access required" });
      return;
    }
  } catch {
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  next();
}

// ── User management (admin only) ─────────────────────────────────────────────

router.get("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  try {
    const users = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        provider: usersTable.provider,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt);
    res.json({ users });
  } catch (err) {
    req.log.error({ err }, "list users error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body as { name?: string; email?: string; password?: string; role?: string };
    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email and password are required" });
      return;
    }
    const normalizedEmail = email.toLowerCase();
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
    if (existing.length > 0) {
      res.status(400).json({ error: "Email already in use" });
      return;
    }
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const validRole = (role === "admin" || role === "auditor") ? role : "user";
    await db.insert(usersTable).values({
      id,
      name,
      email: normalizedEmail,
      password: hashed,
      role: validRole,
      provider: "local",
    });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "create user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/users/:id/reset-password", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { password } = req.body as { password?: string };
  if (!password || password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    // Also switch provider to "local" so Azure SSO accounts can log in with the new password.
    await db.update(usersTable).set({ password: hashed, mustChangePassword: true, provider: "local" }).where(eq(usersTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin reset password error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (id === req.session.userId) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }
  try {
    await db.delete(usersTable).where(eq(usersTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "delete user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/admin/users/:id/role", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { role } = req.body as { role?: string };
  if (role !== "admin" && role !== "user" && role !== "auditor") {
    res.status(400).json({ error: "role must be 'admin', 'auditor', or 'user'" });
    return;
  }
  if (id === req.session.userId && role !== "admin") {
    res.status(400).json({ error: "You cannot remove your own admin role" });
    return;
  }
  try {
    await db.update(usersTable).set({ role }).where(eq(usersTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "update role error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Shared audit helpers ──────────────────────────────────────────────────────

type AuditEvent = {
  id: string;
  type: string;
  documentId: string;
  documentTitle: string;
  uploaderName: string;
  uploaderEmail: string | null;
  actorName: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  timestamp: string;
  note?: string | null;
};

async function buildAuditEvents(): Promise<AuditEvent[]> {
  const documents = await db
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      uploaderName: documentsTable.uploaderName,
      uploadedBy: documentsTable.uploadedBy,
      status: documentsTable.status,
      createdAt: documentsTable.createdAt,
      completedAt: documentsTable.completedAt,
      uploaderEmail: usersTable.email,
    })
    .from(documentsTable)
    .leftJoin(usersTable, eq(documentsTable.uploadedBy, usersTable.id))
    .orderBy(desc(documentsTable.createdAt))
    .limit(500);

  // HARD-6: Scope recipients to documents already selected (max 500) — avoids a
  // full-table scan that grows unboundedly with data.
  const docIds = documents.map((d) => d.id);
  const recipients = docIds.length
    ? await db
        .select({
          id: recipientsTable.id,
          documentId: recipientsTable.documentId,
          teamName: recipientsTable.teamName,
          email: recipientsTable.email,
          signerName: recipientsTable.signerName,
          ipAddress: recipientsTable.ipAddress,
          viewedAt: recipientsTable.viewedAt,
          signedAt: recipientsTable.signedAt,
          requiresReview: recipientsTable.requiresReview,
          reviewStatus: recipientsTable.reviewStatus,
          reviewedAt: recipientsTable.reviewedAt,
          reviewNote: recipientsTable.reviewNote,
        })
        .from(recipientsTable)
        .where(inArray(recipientsTable.documentId, docIds))
    : [];

  const docMap = new Map(documents.map(d => [d.id, d]));

  const events: AuditEvent[] = [];

  for (const doc of documents) {
    events.push({
      id: `upload-${doc.id}`,
      type: "uploaded",
      documentId: doc.id,
      documentTitle: doc.title,
      uploaderName: doc.uploaderName,
      uploaderEmail: doc.uploaderEmail ?? null,
      actorName: doc.uploaderName,
      actorEmail: doc.uploaderEmail ?? null,
      ipAddress: null,
      timestamp: doc.createdAt.toISOString(),
    });

    if (doc.status === "sent" || doc.status === "completed") {
      events.push({
        id: `sent-${doc.id}`,
        type: "sent",
        documentId: doc.id,
        documentTitle: doc.title,
        uploaderName: doc.uploaderName,
        uploaderEmail: doc.uploaderEmail ?? null,
        actorName: doc.uploaderName,
        actorEmail: doc.uploaderEmail ?? null,
        ipAddress: null,
        timestamp: doc.createdAt.toISOString(),
      });
    }

    if (doc.completedAt) {
      events.push({
        id: `complete-${doc.id}`,
        type: "completed",
        documentId: doc.id,
        documentTitle: doc.title,
        uploaderName: doc.uploaderName,
        uploaderEmail: doc.uploaderEmail ?? null,
        actorName: null,
        actorEmail: null,
        ipAddress: null,
        timestamp: doc.completedAt.toISOString(),
      });
    }
  }

  for (const r of recipients) {
    const doc = docMap.get(r.documentId);
    const docTitle = doc?.title ?? "Unknown Document";
    const uploaderName = doc?.uploaderName ?? "";
    const uploaderEmail = doc?.uploaderEmail ?? null;

    if (r.viewedAt) {
      events.push({
        id: `view-${r.id}`,
        type: "viewed",
        documentId: r.documentId,
        documentTitle: docTitle,
        uploaderName,
        uploaderEmail,
        actorName: r.teamName,
        actorEmail: r.email,
        ipAddress: null,
        timestamp: r.viewedAt.toISOString(),
      });
    }

    if (r.signedAt) {
      events.push({
        id: `sign-${r.id}`,
        type: "signed",
        documentId: r.documentId,
        documentTitle: docTitle,
        uploaderName,
        uploaderEmail,
        actorName: r.signerName ?? r.teamName,
        actorEmail: r.email,
        ipAddress: r.ipAddress ?? null,
        timestamp: r.signedAt.toISOString(),
      });
    }

    if (r.requiresReview && r.reviewedAt && r.reviewStatus) {
      const eventType = r.reviewStatus === "approved" ? "review_approved" : "review_changes_requested";
      events.push({
        id: `review-${r.id}`,
        type: eventType,
        documentId: r.documentId,
        documentTitle: docTitle,
        uploaderName,
        uploaderEmail,
        actorName: r.signerName ?? r.teamName,
        actorEmail: r.email,
        ipAddress: r.ipAddress ?? null,
        timestamp: r.reviewedAt.toISOString(),
        note: r.reviewNote ?? null,
      });
    }
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return events.slice(0, 1000);
}

// ── Audit log (admin + auditor) ───────────────────────────────────────────────

router.get("/admin/audit", requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const events = await buildAuditEvents();
    res.json({ events });
  } catch (err) {
    req.log.error({ err }, "audit log error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── CSV export (admin + auditor) ──────────────────────────────────────────────

router.get("/admin/audit/export", requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const events = await buildAuditEvents();

    // SEC-3: Prefix formula-injection characters with a single quote so Excel/Sheets
    // won't execute them when an auditor opens the file.
    const escape = (s: string | null | undefined) => {
      let v = s ?? "";
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return `"${v.replace(/"/g, '""')}"`;
    };

    const headers = ["Event Type", "Document Title", "Document ID", "Uploaded By", "Uploader Email", "Actor Name", "Actor Email", "IP Address", "Timestamp (UTC)", "Note"];
    const rows = events.map(e => [
      e.type,
      e.documentTitle,
      e.documentId,
      e.uploaderName,
      e.uploaderEmail ?? "",
      e.actorName ?? "",
      e.actorEmail ?? "",
      e.ipAddress ?? "",
      new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19),
      e.note ?? "",
    ]);

    const csv = [headers.map(escape).join(","), ...rows.map(r => r.map(escape).join(","))].join("\r\n");

    const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv);
  } catch (err) {
    req.log.error({ err }, "audit export error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
