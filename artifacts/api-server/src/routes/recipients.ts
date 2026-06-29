import { Router, type IRouter } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable } from "@workspace/db";
import { SetRecipientsBody } from "@workspace/api-zod";
import type { Request, Response } from "express";
import { sendSigningEmail, sendReviewInviteEmail, sendSignUnlockEmail } from "./emailService.js";
import { getAppBaseUrl } from "../lib/appUrl.js";
import { remindRateLimit } from "../lib/rateLimiters.js";

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

    await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(recipientsTable)
        .where(eq(recipientsTable.documentId, id));
      existing.sort((a, b) => a.signOrder - b.signOrder);

      const newList = parsed.data.recipients;

      for (let i = 0; i < newList.length; i++) {
        const r = newList[i];
        const existingRec = existing[i];
        const requiresReview = r.requiresReview ?? false;
        const requiresSignature = r.requiresSignature ?? true;
        const reviewChecklistInput = r.reviewChecklist;
        const reviewChecklist = reviewChecklistInput
          ? reviewChecklistInput.map((item) => ({ label: item.label, checked: false }))
          : null;

        if (existingRec) {
          const emailChanged = existingRec.email !== r.email;
          await tx
            .update(recipientsTable)
            .set({
              teamName: r.teamName,
              email: r.email,
              signOrder: i + 1,
              requiresReview,
              requiresSignature,
              reviewStatus: requiresReview ? (emailChanged ? "pending" : (existingRec.reviewStatus ?? "pending")) : null,
              reviewChecklist: reviewChecklist as null,
              // Rotate token and wipe all signing state when email changes so the
              // old link holder cannot sign on behalf of the new assignee.
              ...(emailChanged ? {
                token: uuidv4(),
                tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
                status: "pending",
                signedAt: null,
                signerName: null,
                ipAddress: null,
                signatureData: null,
                viewedAt: null,
                reviewedAt: null,
                reviewNote: null,
              } : {}),
            })
            .where(eq(recipientsTable.id, existingRec.id));
        } else {
          // Token expires 90 days from creation
          const tokenExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
          await tx.insert(recipientsTable).values({
            id: uuidv4(),
            documentId: id,
            teamName: r.teamName,
            email: r.email,
            signOrder: i + 1,
            status: "pending",
            token: uuidv4(),
            requiresReview,
            requiresSignature,
            reviewStatus: requiresReview ? "pending" : null,
            reviewChecklist: reviewChecklist as null,
            tokenExpiresAt,
          });
        }
      }

      if (existing.length > newList.length) {
        for (const removed of existing.slice(newList.length)) {
          await tx.delete(signatureFieldsTable).where(eq(signatureFieldsTable.recipientId, removed.id));
          await tx.delete(recipientsTable).where(eq(recipientsTable.id, removed.id));
        }
      }
    });

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
    const allRecipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id));
    allRecipients.sort((a, b) => a.signOrder - b.signOrder);

    if (allRecipients.length === 0) {
      res.status(400).json({ error: "No recipients added" });
      return;
    }

    const baseUrl = getAppBaseUrl(req);

    // Persist the custom email subject/message so later emails (e.g. sign-unlock
    // after review approval) can still carry the sender's original message.
    const storedSubject = subject?.trim() || null;
    const storedMessage = message?.trim() || null;
    await db
      .update(documentsTable)
      .set({ emailSubject: storedSubject, emailMessage: storedMessage })
      .where(eq(documentsTable.id, id));

    const reviewers = allRecipients.filter((r) => r.requiresReview);
    const signers = allRecipients.filter((r) => r.requiresSignature && !r.requiresReview);

    let sent = 0;

    if (reviewers.length > 0) {
      const toSendReviewers = doc.signingOrder === "sequential" ? [reviewers[0]] : reviewers;
      for (const r of toSendReviewers) {
        await sendReviewInviteEmail(r, doc, `${baseUrl}/review/${r.token}`, req.session.userName, storedSubject, storedMessage);
        sent++;
      }
      await db.update(documentsTable).set({ status: "in_review" as string }).where(eq(documentsTable.id, id));
    } else {
      const toSend = doc.signingOrder === "sequential" ? [signers[0] ?? allRecipients[0]] : allRecipients;
      for (const r of toSend) {
        await sendSigningEmail(r, doc, `${baseUrl}/sign/${r.token}`, storedSubject, storedMessage, req.session.userName);
        sent++;
      }
      await db.update(documentsTable).set({ status: "sent" }).where(eq(documentsTable.id, id));
    }

    res.json({ success: true, sent });
  } catch (err) {
    req.log.error({ err }, "send document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/recipients/:recipientId/remind", requireAuth, remindRateLimit, async (req: Request, res: Response) => {
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
    if (r.status === "signed" && (!r.requiresReview || r.reviewStatus === "approved")) {
      res.status(400).json({ error: "Recipient has already completed their action" });
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
    const baseUrl = getAppBaseUrl(req);

    if (r.requiresReview && (r.reviewStatus === null || r.reviewStatus === "pending")) {
      await sendReviewInviteEmail(r, doc, `${baseUrl}/review/${r.token}`, req.session.userName);
    } else if (r.requiresSignature && r.status !== "signed") {
      const allRecipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, r.documentId));
      const reviewers = allRecipients.filter((x) => x.requiresReview);
      const gateOpen = reviewers.every((x) => x.reviewStatus === "approved");
      const approvedNames = reviewers.filter((x) => x.reviewStatus === "approved").map((x) => x.signerName || x.teamName);
      if (!gateOpen) {
        res.status(400).json({ error: "Cannot send signing reminder — reviewers have not approved yet" });
        return;
      }
      await sendSignUnlockEmail(r, doc, `${baseUrl}/sign/${r.token}`, approvedNames);
    } else {
      await sendSigningEmail(
        r, doc, `${baseUrl}/sign/${r.token}`,
        `Reminder: Please sign "${doc.title}"`,
        "This is a reminder that your signature is required on this document.",
        req.session.userName
      );
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "remind recipient error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/documents/:id/remind-all", requireAuth, remindRateLimit, async (req: Request, res: Response) => {
  const documentId = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, documentId), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    if (docs.length === 0) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    const doc = docs[0];
    const baseUrl = getAppBaseUrl(req);

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, documentId));

    const reviewers = allRecipients.filter((x) => x.requiresReview);
    const gateOpen = reviewers.every((x) => x.reviewStatus === "approved");
    const approvedNames = reviewers.filter((x) => x.reviewStatus === "approved").map((x) => x.signerName || x.teamName);

    let sent = 0;
    const errors: string[] = [];

    for (const r of allRecipients) {
      const alreadyDone =
        r.status === "signed" &&
        (!r.requiresReview || r.reviewStatus === "approved" || r.reviewStatus === "changes_requested");
      if (alreadyDone) continue;

      try {
        if (r.requiresReview && (r.reviewStatus === null || r.reviewStatus === "pending")) {
          await sendReviewInviteEmail(r, doc, `${baseUrl}/review/${r.token}`, req.session.userName);
          sent++;
        } else if (r.requiresSignature && r.status !== "signed") {
          if (!gateOpen) continue; // skip silently — gate not open yet
          await sendSignUnlockEmail(r, doc, `${baseUrl}/sign/${r.token}`, approvedNames);
          sent++;
        } else if (!r.requiresReview && !r.requiresSignature) {
          continue;
        } else {
          await sendSigningEmail(
            r, doc, `${baseUrl}/sign/${r.token}`,
            `Reminder: Please sign "${doc.title}"`,
            "This is a reminder that your signature is required on this document.",
            req.session.userName
          );
          sent++;
        }
      } catch (e) {
        errors.push(r.email);
        req.log.warn({ err: e, recipientId: r.id }, "remind-all: failed to send to one recipient");
      }
    }

    res.json({ success: true, sent, errors });
  } catch (err) {
    req.log.error({ err }, "remind-all error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
