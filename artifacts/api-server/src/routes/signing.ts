import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable, documentEventsTable } from "@workspace/db";
import fs from "fs";
import path from "path";
import { SubmitSignatureBody } from "@workspace/api-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { Request, Response } from "express";
import { sendSigningEmail, sendReviewInviteEmail, sendSignUnlockEmail } from "./emailService.js";
import { getAppBaseUrl } from "../lib/appUrl.js";
import { buildSignedPdf, SignerRecord, DocMeta, ReviewerRecord } from "./pdfSigner.js";
import { downloadFromGcs, streamFromGcs, isGcsPath, uploadToGcs } from "../lib/gcsStorage.js";
import { createHash } from "crypto";

const router: IRouter = Router();

const SubmitReviewBody = z.object({
  decision: z.enum(["approve", "request_changes"]),
  checklist: z.array(z.object({ label: z.string(), checked: z.boolean() })).nullish(),
  note: z.string().max(2000).nullish(),
});

async function fileExists(filepath: string): Promise<boolean> {
  if (isGcsPath(filepath)) return true;
  return fs.existsSync(filepath);
}

async function getFileBuffer(filepath: string): Promise<Buffer> {
  if (isGcsPath(filepath)) {
    return downloadFromGcs(filepath);
  }
  return fs.promises.readFile(filepath);
}

async function insertEvent(data: {
  documentId: string;
  recipientId?: string;
  eventType: string;
  actorName?: string | null;
  actorEmail?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  await db.insert(documentEventsTable).values({
    id: uuidv4(),
    documentId: data.documentId,
    recipientId: data.recipientId ?? null,
    eventType: data.eventType,
    actorName: data.actorName ?? null,
    actorEmail: data.actorEmail ?? null,
    metadata: (data.metadata ?? null) as null,
    ipAddress: data.ipAddress ?? null,
    userAgent: data.userAgent ?? null,
    createdAt: new Date(),
  });
}

type RecipientRow = typeof recipientsTable.$inferSelect;

function computeNextStep(
  recipient: RecipientRow,
  allRecipients: RecipientRow[]
): "review" | "sign" | "done" | "blocked" {
  const reviewers = allRecipients.filter((r) => r.requiresReview);
  const gateOpen = reviewers.every((r) => r.reviewStatus === "approved");

  if (recipient.requiresReview) {
    if (
      recipient.reviewStatus === null ||
      recipient.reviewStatus === "pending" ||
      recipient.reviewStatus === undefined
    ) {
      return "review";
    }
    if (recipient.requiresSignature && recipient.status !== "signed") {
      return gateOpen ? "sign" : "blocked";
    }
    return "done";
  }

  if (recipient.requiresSignature) {
    if (recipient.status === "signed") return "done";
    return gateOpen ? "sign" : "blocked";
  }

  return "done";
}

async function maybeUnlockSigners(
  documentId: string,
  baseUrl: string,
  doc: { title: string; filename: string; signingOrder: string },
  triggeredByName: string | null
) {
  const allRecipients = await db
    .select()
    .from(recipientsTable)
    .where(eq(recipientsTable.documentId, documentId));

  const reviewers = allRecipients.filter((r) => r.requiresReview);
  if (!reviewers.every((r) => r.reviewStatus === "approved")) return;

  const approvedReviewerNames = reviewers
    .map((r) => r.signerName || r.teamName)
    .filter(Boolean);

  const pendingSigners = allRecipients.filter(
    (r) => r.requiresSignature && r.status !== "signed" && !r.requiresReview
  );

  const toSend =
    doc.signingOrder === "sequential"
      ? pendingSigners.slice(0, 1)
      : pendingSigners;

  for (const signer of toSend) {
    await sendSignUnlockEmail(
      signer,
      doc,
      `${baseUrl}/sign/${signer.token}`,
      approvedReviewerNames
    );
  }

  const docStatus = doc.signingOrder === "simultaneous" && pendingSigners.length === 0
    ? "completed"
    : "sent";

  if (reviewers.length > 0 && pendingSigners.length > 0) {
    await db
      .update(documentsTable)
      .set({ status: docStatus })
      .where(eq(documentsTable.id, documentId));
  }
}

router.get("/signing/my-requests", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const email = (req.session.userEmail ?? "").toLowerCase();

    const recipients = await db
      .select({
        id: recipientsTable.id,
        documentId: recipientsTable.documentId,
        status: recipientsTable.status,
        token: recipientsTable.token,
        signedAt: recipientsTable.signedAt,
        teamName: recipientsTable.teamName,
      })
      .from(recipientsTable)
      .where(eq(recipientsTable.email, email));

    if (recipients.length === 0) {
      res.json({ requests: [] });
      return;
    }

    const documentIds = [...new Set(recipients.map((r) => r.documentId))];
    const documents = await db
      .select({
        id: documentsTable.id,
        title: documentsTable.title,
        uploaderName: documentsTable.uploaderName,
        status: documentsTable.status,
        createdAt: documentsTable.createdAt,
      })
      .from(documentsTable)
      .where(inArray(documentsTable.id, documentIds));

    const docMap = new Map(documents.map((d) => [d.id, d]));

    const requests = recipients
      .map((r) => {
        const doc = docMap.get(r.documentId);
        return {
          documentId: r.documentId,
          documentTitle: doc?.title ?? "Unknown Document",
          senderName: doc?.uploaderName ?? "Unknown",
          recipientStatus: r.status,
          token: r.token,
          signedAt: r.signedAt?.toISOString() ?? null,
          sentAt: doc?.createdAt.toISOString() ?? null,
        };
      })
      .sort((a, b) => {
        const aIsPending = a.recipientStatus !== "signed";
        const bIsPending = b.recipientStatus !== "signed";
        if (aIsPending && !bIsPending) return -1;
        if (!aIsPending && bIsPending) return 1;
        return new Date(b.sentAt ?? 0).getTime() - new Date(a.sentAt ?? 0).getTime();
      });

    res.json({ requests });
  } catch (err) {
    req.log.error({ err }, "my signing requests error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sign/:token", async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.token, token))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid or expired signing link" });
      return;
    }

    const r = recs[0];
    const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
    const doc = docs[0];

    if (r.status !== "signed" && !r.requiresReview) {
      await db
        .update(recipientsTable)
        .set({ status: "viewed", viewedAt: new Date() })
        .where(eq(recipientsTable.token, token));
    }

    const fields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.recipientId, r.id));

    let allSignedFields: typeof fields = [];
    if (doc?.status === "completed") {
      allSignedFields = await db
        .select()
        .from(signatureFieldsTable)
        .where(eq(signatureFieldsTable.documentId, r.documentId));
    }

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const nextStep = computeNextStep(r, allRecipients);

    const approvedReviewers = allRecipients
      .filter((x) => x.requiresReview && x.reviewStatus === "approved")
      .map((x) => ({
        name: x.signerName || x.teamName,
        teamName: x.teamName,
        reviewedAt: x.reviewedAt?.toISOString() ?? new Date().toISOString(),
      }));

    res.json({
      recipient: r,
      documentTitle: doc?.title ?? "Unknown Document",
      documentFilename: doc?.filename ?? "",
      alreadySigned: r.status === "signed",
      documentStatus: doc?.status ?? "sent",
      fields,
      allSignedFields,
      nextStep,
      approvedReviewers,
    });
  } catch (err) {
    req.log.error({ err }, "get signing info error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/sign/:token/review", async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const parsed = SubmitReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid review submission" });
      return;
    }

    const { decision, checklist, note } = parsed.data;

    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.token, token))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid review link" });
      return;
    }

    const r = recs[0];

    if (!r.requiresReview) {
      res.status(400).json({ error: "This link is not a review link" });
      return;
    }

    // Allow changing a previous decision (e.g. approved → request_changes or vice-versa)

    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
    const ua = req.headers["user-agent"] ?? null;
    const reviewStatus = decision === "approve" ? "approved" : "changes_requested";

    await db
      .update(recipientsTable)
      .set({
        reviewStatus,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
        reviewChecklist: checklist ?? null,
        status: "viewed",
        viewedAt: new Date(),
        signerName: r.teamName,
        ipAddress: ip,
      })
      .where(eq(recipientsTable.token, token));

    const eventType = decision === "approve" ? "review_approved" : "review_changes_requested";
    await insertEvent({
      documentId: r.documentId,
      recipientId: r.id,
      eventType,
      actorName: r.teamName,
      actorEmail: r.email,
      metadata: { decision, note: note ?? null, checklist: checklist ?? null },
      ipAddress: ip,
      userAgent: ua,
    });

    if (decision === "approve") {
      const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
      const doc = docs[0];
      if (doc) {
        const baseUrl = getAppBaseUrl(req);
        await maybeUnlockSigners(r.documentId, baseUrl, doc, r.teamName);
      }
    }

    // Re-fetch all recipients to compute accurate nextStep after the update
    const allRecipientsAfter = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const updatedRecipient = allRecipientsAfter.find((x) => x.token === token)!;
    const nextStep = computeNextStep(updatedRecipient, allRecipientsAfter);

    res.json({ success: true, nextStep, requiresSignature: r.requiresSignature });
  } catch (err) {
    req.log.error({ err }, "submit review error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/sign/:token", async (req: Request, res: Response) => {
  const token = req.params.token as string;
  try {
    const parsed = SubmitSignatureBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Full name and signature are required" });
      return;
    }

    const { fullName, signatureData, fieldValues } = parsed.data;

    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.token, token))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid signing link" });
      return;
    }

    const r = recs[0];

    if (r.status === "signed") {
      res.status(400).json({ error: "Already signed" });
      return;
    }

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const nextStep = computeNextStep(r, allRecipients);
    if (nextStep === "blocked") {
      res.status(409).json({ error: "Document is awaiting reviewer approval before signing is allowed" });
      return;
    }
    if (nextStep === "review") {
      res.status(409).json({ error: "You must complete your review before signing" });
      return;
    }

    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
    const ua = req.headers["user-agent"] ?? null;

    await db
      .update(recipientsTable)
      .set({
        status: "signed",
        signedAt: new Date(),
        signerName: fullName,
        ipAddress: ip,
        signatureData: signatureData ?? null,
      })
      .where(eq(recipientsTable.token, token));

    await insertEvent({
      documentId: r.documentId,
      recipientId: r.id,
      eventType: "signed",
      actorName: fullName,
      actorEmail: r.email,
      ipAddress: ip,
      userAgent: ua,
    });

    const recipientFields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.recipientId, r.id));

    for (const field of recipientFields) {
      let value: string | null = null;
      if (field.fieldType === "signature" || field.fieldType === "initials") {
        value = signatureData ?? null;
      } else if (fieldValues && fieldValues[field.id] !== undefined) {
        value = fieldValues[field.id];
      }
      if (value !== null) {
        await db
          .update(signatureFieldsTable)
          .set({ fieldValue: value })
          .where(eq(signatureFieldsTable.id, field.id));
      }
    }

    const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
    const doc = docs[0];

    const freshRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const signers = freshRecipients.filter((x) => x.requiresSignature);

    if (doc?.signingOrder === "sequential") {
      freshRecipients.sort((a, b) => a.signOrder - b.signOrder);
      const next = freshRecipients.find(
        (x) => x.requiresSignature && !x.requiresReview && x.signOrder === r.signOrder + 1 && x.status === "pending"
      );
      if (next) {
        const baseUrl = getAppBaseUrl(req);
        await sendSigningEmail(next, doc, `${baseUrl}/sign/${next.token}`, null, null, "E-Sign Workflow");
      }
    }

    if (signers.every((x) => x.status === "signed" || x.id === r.id)) {
      const now = new Date();
      await db
        .update(documentsTable)
        .set({ status: "completed", completedAt: now })
        .where(eq(documentsTable.id, r.documentId));

      await insertEvent({
        documentId: r.documentId,
        eventType: "completed",
        actorName: "System",
        actorEmail: null,
      });

      if (doc) {
        try {
          const allFields = await db
            .select()
            .from(signatureFieldsTable)
            .where(eq(signatureFieldsTable.documentId, r.documentId));

          const reviewerRecords: ReviewerRecord[] = freshRecipients
            .filter((x) => x.requiresReview && x.reviewStatus === "approved")
            .map((x) => ({
              name: x.signerName || x.teamName,
              email: x.email,
              reviewedAt: x.reviewedAt ?? now,
              ipAddress: x.ipAddress,
              decision: "approved" as const,
              note: x.reviewNote,
            }));

          const signedRecipients = freshRecipients.filter((x) => x.status === "signed" || x.id === r.id);
          const entries = signedRecipients.flatMap((sr) => {
            const rFields = allFields.filter((f) => f.recipientId === sr.id);
            const signedAt = sr.signedAt ? new Date(sr.signedAt) : now;
            const name = (sr.id === r.id ? fullName : sr.signerName) || sr.teamName;
            return rFields.filter((f) => f.fieldValue).map((f) => ({
              fieldType: (f.fieldType || "signature") as "signature" | "initials" | "date" | "text",
              fieldValue: f.fieldValue!,
              signerName: name,
              signedAt,
              page: f.page,
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
            }));
          });

          const signerRecords: SignerRecord[] = signedRecipients.map((sr) => ({
            name: (sr.id === r.id ? fullName : sr.signerName) || sr.teamName,
            email: sr.email,
            signedAt: sr.signedAt ? new Date(sr.signedAt) : now,
            ipAddress: sr.ipAddress,
          }));

          const docMeta: DocMeta = { documentName: doc.filename, documentId: doc.id, completedAt: now };
          const source = isGcsPath(doc.filepath) ? await getFileBuffer(doc.filepath) : doc.filepath;
          const sealedBytes = await buildSignedPdf(source, entries, { doc: docMeta, signers: signerRecords, reviewers: reviewerRecords });
          const sealedBuf = Buffer.from(sealedBytes);
          const sealedHash = createHash("sha256").update(sealedBuf).digest("hex");

          const gcsPath = await uploadToGcs(sealedBuf, `sealed/${doc.id}.pdf`, "application/pdf");
          await db.update(documentsTable).set({ sealedPdfPath: gcsPath, sealedPdfHash: sealedHash }).where(eq(documentsTable.id, r.documentId));

          await insertEvent({
            documentId: r.documentId,
            eventType: "sealed",
            actorName: "System",
            actorEmail: null,
            metadata: { sealedHash, gcsPath },
          });
        } catch (sealErr) {
          req.log.error({ sealErr }, "non-fatal: failed to seal PDF after completion");
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "submit signature error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sign/:token/download", async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const recs = await db.select().from(recipientsTable).where(eq(recipientsTable.token, token)).limit(1);
    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid signing link" });
      return;
    }
    const docId = recs[0].documentId;
    const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, docId)).limit(1);
    const doc = docs[0];
    if (!doc || !(await fileExists(doc.filepath))) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const allRecipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, docId));
    const signedRecipients = allRecipients.filter((r) => r.status === "signed");
    const signers = allRecipients.filter((r) => r.requiresSignature);

    if (signedRecipients.length < signers.length) {
      res.status(403).json({ error: "The signed document will be available for download once all parties have completed signing." });
      return;
    }

    if (doc.sealedPdfPath) {
      try {
        const sealedBuf = await downloadFromGcs(doc.sealedPdfPath);
        const safeName = doc.filename.replace(/[^a-z0-9.\-_]/gi, "_");
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="${safeName}"`);
        res.send(sealedBuf);
        return;
      } catch {
        req.log.warn("sealed PDF not found in GCS, falling back to on-demand generation");
      }
    }

    const allFields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.documentId, docId));

    const entries = signedRecipients.flatMap((r) => {
      const recipientFields = allFields.filter((f) => f.recipientId === r.id);
      const signedAt = r.signedAt ? new Date(r.signedAt) : new Date();
      const signerName = r.signerName || r.teamName;
      return recipientFields
        .filter((f) => f.fieldValue)
        .map((f) => ({
          fieldType: (f.fieldType || "signature") as "signature" | "initials" | "date" | "text",
          fieldValue: f.fieldValue!,
          signerName,
          signedAt,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        }));
    });

    const signerRecords: SignerRecord[] = signedRecipients.map((r) => ({
      name: r.signerName || r.teamName,
      email: r.email,
      signedAt: r.signedAt ? new Date(r.signedAt) : new Date(),
      ipAddress: r.ipAddress,
    }));

    const reviewerRecords: ReviewerRecord[] = allRecipients
      .filter((r) => r.requiresReview && r.reviewStatus === "approved")
      .map((r) => ({
        name: r.signerName || r.teamName,
        email: r.email,
        reviewedAt: r.reviewedAt ?? new Date(),
        ipAddress: r.ipAddress,
        decision: "approved" as const,
        note: r.reviewNote,
      }));

    const completedAt = signedRecipients.reduce<Date>((latest, r) => {
      const t = r.signedAt ? new Date(r.signedAt) : new Date();
      return t > latest ? t : latest;
    }, new Date(0));

    const docMeta: DocMeta = { documentName: doc.filename, documentId: doc.id, completedAt };

    const source = isGcsPath(doc.filepath) ? await getFileBuffer(doc.filepath) : doc.filepath;
    const pdfBytes = await buildSignedPdf(source, entries, { doc: docMeta, signers: signerRecords, reviewers: reviewerRecords });
    const safeName = doc.filename.replace(/[^a-z0-9.\-_]/gi, "_");
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${safeName}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    req.log.error({ err }, "download signed pdf error");
    res.status(500).json({ error: "Failed to generate signed PDF" });
  }
});

router.get("/sign/:token/file", async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const recs = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.token, token))
      .limit(1);

    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid signing link" });
      return;
    }

    const docs = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.id, recs[0].documentId))
      .limit(1);

    if (!docs[0] || !(await fileExists(docs[0].filepath))) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const doc = docs[0];
    if (isGcsPath(doc.filepath)) {
      await streamFromGcs(doc.filepath, res, "application/pdf");
    } else {
      const ext = path.extname(doc.filepath).toLowerCase();
      const contentType = ext === ".pdf" ? "application/pdf" : "application/octet-stream";
      res.set("Content-Type", contentType);
      res.set("Cache-Control", "private, max-age=300");
      res.sendFile(path.resolve(doc.filepath));
    }
  } catch (err) {
    req.log.error({ err }, "serve sign file error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/documents/:id/activity", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.id, id))
      .limit(1);

    if (docs.length === 0 || docs[0].uploadedBy !== req.session.userId) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const events = await db
      .select()
      .from(documentEventsTable)
      .where(eq(documentEventsTable.documentId, id))
      .orderBy(documentEventsTable.createdAt);

    res.json({
      events: events.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "get document activity error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
