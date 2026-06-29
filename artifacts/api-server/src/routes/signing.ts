import { Router, type IRouter } from "express";
import { eq, inArray, and, count, ne } from "drizzle-orm";
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
import { downloadFromGcs, streamFromGcs, isGcsPath, uploadToGcs, StorageFileNotFoundError } from "../lib/gcsStorage.js";
import { createHash } from "crypto";
import { signingRateLimit } from "../lib/rateLimiters.js";

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
  allRecipients: RecipientRow[],
  signingOrder: string
): "review" | "sign" | "done" | "blocked" {
  const reviewers = allRecipients.filter((r) => r.requiresReview);
  const gateOpen = reviewers.every((r) => r.reviewStatus === "approved");

  // Helper: returns true when any earlier-ordered signer hasn't finished yet
  const priorSignerPending = (rec: RecipientRow): boolean =>
    signingOrder === "sequential" &&
    allRecipients.some(
      (r) =>
        r.requiresSignature &&
        r.signOrder < rec.signOrder &&
        r.status !== "signed"
    );

  if (recipient.requiresReview) {
    if (
      recipient.reviewStatus === null ||
      recipient.reviewStatus === "pending" ||
      recipient.reviewStatus === undefined
    ) {
      return "review";
    }
    if (recipient.requiresSignature && recipient.status !== "signed") {
      if (!gateOpen) return "blocked";
      if (priorSignerPending(recipient)) return "blocked";
      return "sign";
    }
    return "done";
  }

  if (recipient.requiresSignature) {
    if (recipient.status === "signed") return "done";
    if (!gateOpen) return "blocked";
    if (priorSignerPending(recipient)) return "blocked";
    return "sign";
  }

  return "done";
}

async function maybeUnlockSigners(
  documentId: string,
  baseUrl: string,
  doc: { title: string; filename: string; signingOrder: string; emailSubject?: string | null; emailMessage?: string | null },
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
      approvedReviewerNames,
      doc.emailMessage ?? null
    );
  }

  // BUG-3: If all reviewers approved but there are no signers, mark the document
  // completed immediately (review-only workflow). Otherwise unlock pending signers.
  if (reviewers.length > 0) {
    if (pendingSigners.length === 0) {
      await db
        .update(documentsTable)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(documentsTable.id, documentId));
    } else {
      await db
        .update(documentsTable)
        .set({ status: "sent" })
        .where(eq(documentsTable.id, documentId));
    }
  }
}

router.get("/signing/my-requests", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!req.session.emailVerified) {
    res.json({ requests: [] });
    return;
  }
  try {
    const email = (req.session.userEmail ?? "").toLowerCase();

    const recipients = await db
      .select({
        id: recipientsTable.id,
        documentId: recipientsTable.documentId,
        status: recipientsTable.status,
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
          recipientId: r.id,
          documentId: r.documentId,
          documentTitle: doc?.title ?? "Unknown Document",
          senderName: doc?.uploaderName ?? "Unknown",
          recipientStatus: r.status,
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

router.get("/sign/:token", signingRateLimit, async (req: Request, res: Response) => {
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
    // Reject if token is past its expiry date
    if (r.tokenExpiresAt && r.tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
      return;
    }

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

    const nextStep = computeNextStep(r, allRecipients, doc?.signingOrder ?? "simultaneous");

    const approvedReviewers = allRecipients
      .filter((x) => x.requiresReview && x.reviewStatus === "approved")
      .map((x) => ({
        name: x.signerName || x.teamName,
        teamName: x.teamName,
        reviewedAt: x.reviewedAt?.toISOString() ?? new Date().toISOString(),
        note: x.reviewNote ?? null,
      }));

    const rejectedReviewers = allRecipients
      .filter((x) => x.requiresReview && x.reviewStatus === "changes_requested")
      .map((x) => ({
        name: x.signerName || x.teamName,
        teamName: x.teamName,
        reviewedAt: x.reviewedAt?.toISOString() ?? null,
        note: x.reviewNote ?? null,
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
      reviewRejected: rejectedReviewers.length > 0,
      rejectedReviewers,
    });
  } catch (err) {
    req.log.error({ err }, "get signing info error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/sign/:token/review", signingRateLimit, async (req: Request, res: Response) => {
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

    if (r.tokenExpiresAt && r.tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
      return;
    }

    if (!r.requiresReview) {
      res.status(400).json({ error: "This link is not a review link" });
      return;
    }

    // Allow changing a previous decision (e.g. approved → request_changes or vice-versa)

    // SEC-2: Use req.ip (set by Express trust proxy) rather than raw x-forwarded-for
    // to prevent IP spoofing by a client injecting forged header values.
    const ip = req.ip ?? req.socket.remoteAddress ?? "";
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

    const reviewDocs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
    const reviewDoc = reviewDocs[0];

    if (decision === "approve" && reviewDoc) {
      const baseUrl = getAppBaseUrl(req);
      await maybeUnlockSigners(r.documentId, baseUrl, reviewDoc, r.teamName);
    }

    // Re-fetch all recipients to compute accurate nextStep after the update
    const allRecipientsAfter = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const updatedRecipient = allRecipientsAfter.find((x) => x.token === token)!;
    const nextStep = computeNextStep(updatedRecipient, allRecipientsAfter, reviewDoc?.signingOrder ?? "simultaneous");

    res.json({ success: true, nextStep, requiresSignature: r.requiresSignature });
  } catch (err) {
    req.log.error({ err }, "submit review error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/sign/:token", signingRateLimit, async (req: Request, res: Response) => {
  const token = req.params.token as string;
  try {
    const parsed = SubmitSignatureBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Full name and signature are required" });
      return;
    }

    const { fullName, signatureData, fieldValues } = parsed.data;

    // HARD-4: Cap signature payload to prevent oversized writes.
    if (signatureData && signatureData.length > 600_000) {
      res.status(400).json({ error: "Signature data is too large" });
      return;
    }

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

    if (r.tokenExpiresAt && r.tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
      return;
    }

    if (r.status === "signed") {
      res.status(400).json({ error: "Already signed" });
      return;
    }

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    const docs = await db.select().from(documentsTable).where(eq(documentsTable.id, r.documentId)).limit(1);
    const doc = docs[0];

    const nextStep = computeNextStep(r, allRecipients, doc?.signingOrder ?? "simultaneous");
    if (nextStep === "blocked") {
      res.status(409).json({ error: "Signing is not yet available — either awaiting reviewer approval or a prior signer has not yet completed" });
      return;
    }
    if (nextStep === "review") {
      res.status(409).json({ error: "You must complete your review before signing" });
      return;
    }

    // SEC-2: Use req.ip (set by Express trust proxy) rather than raw x-forwarded-for.
    const ip = req.ip ?? req.socket.remoteAddress ?? "";
    const ua = req.headers["user-agent"] ?? null;

    // Fetch fields before the transaction (read-only, doesn't need to be atomic with writes)
    const recipientFields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.recipientId, r.id));

    const now = new Date();
    let allDone = false;

    // Wrap all DB mutations atomically so a crash mid-way can't leave partial state
    // (e.g. recipient marked signed but document still shows "in_progress").
    await db.transaction(async (tx) => {
      await tx
        .update(recipientsTable)
        .set({
          status: "signed",
          signedAt: now,
          signerName: fullName,
          ipAddress: ip,
          signatureData: signatureData ?? null,
        })
        .where(eq(recipientsTable.token, token));

      await tx.insert(documentEventsTable).values({
        id: uuidv4(),
        documentId: r.documentId,
        recipientId: r.id,
        eventType: "signed",
        actorName: fullName,
        actorEmail: r.email,
        ipAddress: ip,
        userAgent: ua,
        createdAt: now,
      });

      for (const field of recipientFields) {
        let value: string | null = null;
        if (field.fieldType === "signature" || field.fieldType === "initials") {
          value = signatureData ?? null;
        } else if (fieldValues && fieldValues[field.id] !== undefined) {
          value = fieldValues[field.id];
        }
        if (value !== null) {
          await tx
            .update(signatureFieldsTable)
            .set({ fieldValue: value })
            .where(eq(signatureFieldsTable.id, field.id));
        }
      }

      // BUG-2: Re-count unsigned signers directly in DB so concurrent signers
      // don't both read a stale snapshot and both miss the completion trigger.
      const remaining = await tx
        .select({ n: count() })
        .from(recipientsTable)
        .where(
          and(
            eq(recipientsTable.documentId, r.documentId),
            eq(recipientsTable.requiresSignature, true),
            ne(recipientsTable.status, "signed"),
          )
        );

      allDone = Number(remaining[0].n) === 0;

      if (allDone) {
        await tx
          .update(documentsTable)
          .set({ status: "completed", completedAt: now })
          .where(eq(documentsTable.id, r.documentId));

        await tx.insert(documentEventsTable).values({
          id: uuidv4(),
          documentId: r.documentId,
          eventType: "completed",
          actorName: "System",
          actorEmail: null,
          createdAt: now,
        });
      }
    });

    // Fetch fresh recipient list after the transaction commits (for email/PDF background tasks)
    const freshRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    // Respond immediately — background tasks (email + PDF sealing) must not
    // block the signer's browser.
    res.json({ success: true });

    // ── Background: send next-signer email (sequential workflow) ─────────
    if (doc?.signingOrder === "sequential") {
      const sorted = [...freshRecipients].sort((a, b) => a.signOrder - b.signOrder);
      const next = sorted.find(
        (x) => x.requiresSignature && !x.requiresReview && x.signOrder === r.signOrder + 1 && x.status === "pending"
      );
      if (next) {
        const baseUrl = getAppBaseUrl(req);
        sendSigningEmail(next, doc, `${baseUrl}/sign/${next.token}`, null, null, "E-Sign Workflow")
          .catch((err) => req.log.error({ err }, "failed to send next signing email"));
      }
    }

    // ── Background: seal the completed PDF (GCS download + pdf-lib + upload) ──
    if (allDone && doc) {
      setImmediate(async () => {
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
            const signerName = (sr.id === r.id ? fullName : sr.signerName) || sr.teamName || sr.email;
            return rFields.flatMap((f) => {
              const ft = (f.fieldType || "signature") as "signature" | "initials" | "date" | "text";
              if (f.fieldValue) {
                return [{ fieldType: ft, fieldValue: f.fieldValue, signerName, signedAt, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }];
              }
              if (ft === "signature" || ft === "initials") {
                return [{ fieldType: "text" as const, fieldValue: "Electronically Signed", signerName, signedAt, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }];
              }
              return [];
            });
          });

          const signerRecords: SignerRecord[] = signedRecipients.map((sr) => ({
            name: (sr.id === r.id ? fullName : sr.signerName) || sr.teamName || sr.email,
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
      });
    }
  } catch (err) {
    req.log.error({ err }, "submit signature error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sign/:token/download", signingRateLimit, async (req: Request, res: Response) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = req.params.token as string;
  try {
    const recs = await db.select().from(recipientsTable).where(eq(recipientsTable.token, token)).limit(1);
    if (recs.length === 0) {
      res.status(404).json({ error: "Invalid signing link" });
      return;
    }
    if (recs[0].tokenExpiresAt && recs[0].tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
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
      const signerName = r.signerName || r.teamName || r.email;
      return recipientFields.flatMap((f) => {
        const ft = (f.fieldType || "signature") as "signature" | "initials" | "date" | "text";
        if (f.fieldValue) {
          return [{ fieldType: ft, fieldValue: f.fieldValue, signerName, signedAt, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }];
        }
        if (ft === "signature" || ft === "initials") {
          return [{ fieldType: "text" as const, fieldValue: "Electronically Signed", signerName, signedAt, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }];
        }
        return [];
      });
    });

    const signerRecords: SignerRecord[] = signedRecipients.map((r) => ({
      name: r.signerName || r.teamName || r.email,
      email: r.email,
      signedAt: r.signedAt ? new Date(r.signedAt) : new Date(),
      ipAddress: r.ipAddress,
    }));

    const reviewerRecords: ReviewerRecord[] = allRecipients
      .filter((r) => r.requiresReview && r.reviewStatus === "approved")
      .map((r) => ({
        name: r.signerName || r.teamName || r.email,
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
    const pdfBuf = Buffer.from(pdfBytes);
    const safeName = doc.filename.replace(/[^a-z0-9.\-_]/gi, "_");
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${safeName}"`);
    res.set("Content-Length", String(pdfBuf.byteLength));
    res.send(pdfBuf);
  } catch (err) {
    if (err instanceof StorageFileNotFoundError) {
      req.log.warn({ err }, "document file not found in storage");
      res.status(404).json({ error: "The document file could not be found. It may have been uploaded from a different environment — please re-upload the document." });
      return;
    }
    req.log.error({ err }, "download signed pdf error");
    res.status(500).json({ error: "Failed to generate signed PDF" });
  }
});

router.get("/sign/:token/file", signingRateLimit, async (req: Request, res: Response) => {
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

    if (recs[0].tokenExpiresAt && recs[0].tokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This signing link has expired" });
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
    if (err instanceof StorageFileNotFoundError) {
      req.log.warn({ err }, "sign file not found in storage");
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
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
