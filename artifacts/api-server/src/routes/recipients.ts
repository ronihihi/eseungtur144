import { Router, type IRouter } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import { db, documentsTable, recipientsTable } from "@workspace/db";
import { SetRecipientsBody } from "@workspace/api-zod";
import type { Request, Response } from "express";
import { sendSigningEmail } from "./emailService.js";

const router: IRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Please log in first" });
    return;
  }
  next();
}

router.post("/documents/:id/recipients", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const parsed = SetRecipientsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid recipients data" });
      return;
    }

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    await db.delete(recipientsTable).where(eq(recipientsTable.documentId, id));

    await Promise.all(
      parsed.data.recipients.map((r, i) =>
        db.insert(recipientsTable).values({
          id: uuidv4(),
          documentId: id,
          teamName: r.teamName,
          email: r.email,
          signOrder: i + 1,
          status: "pending",
          token: uuidv4(),
        })
      )
    );

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "set recipients error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/documents/:id/send", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const { subject, message } = req.body as { subject?: string; message?: string };

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const doc = docs[0];
    const recipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id));
    recipients.sort((a, b) => a.signOrder - b.signOrder);

    if (recipients.length === 0) {
      res.status(400).json({ error: "No recipients added" });
      return;
    }

    const host = req.get("host") || "localhost";
    const protocol = req.protocol || "https";
    const baseUrl = process.env.APP_URL || `${protocol}://${host}`;

    const toSend = doc.signingOrder === "sequential" ? [recipients[0]] : recipients;

    for (const r of toSend) {
      await sendSigningEmail(r, doc, `${baseUrl}/sign/${r.token}`, subject, message, req.session.userName);
    }

    await db.update(documentsTable).set({ status: "sent" }).where(eq(documentsTable.id, id));

    res.json({ success: true, sent: toSend.length });
  } catch (err) {
    req.log.error({ err }, "send document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/recipients/:recipientId/remind", requireAuth, async (req: Request, res: Response) => {
  const recipientId = req.params.recipientId as string;
  try {
    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.id, recipientId))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Recipient not found" });
      return;
    }

    const r = recs[0];
    if (r.status === "signed") {
      res.status(400).json({ error: "Recipient has already signed" });
      return;
    }

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, r.documentId), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    if (docs.length === 0) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    const doc = docs[0];

    const host = req.get("host") || "localhost";
    const protocol = req.protocol || "https";
    const baseUrl = process.env.APP_URL || `${protocol}://${host}`;

    await sendSigningEmail(
      r,
      doc,
      `${baseUrl}/sign/${r.token}`,
      `Reminder: Please sign "${doc.title}"`,
      "This is a reminder that your signature is required on this document.",
      req.session.userName
    );

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "remind recipient error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
