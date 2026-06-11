import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable } from "@workspace/db";
import fs from "fs";
import path from "path";
import { SubmitSignatureBody } from "@workspace/api-zod";
import type { Request, Response } from "express";
import { sendSigningEmail } from "./emailService.js";
import { getAppBaseUrl } from "../lib/appUrl.js";
import { buildSignedPdf } from "./pdfSigner.js";
import { downloadFromGcs, streamFromGcs, isGcsPath } from "../lib/gcsStorage.js";

const router: IRouter = Router();

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

// Authenticated: documents the current user has been asked to sign
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

    if (r.status !== "signed") {
      await db
        .update(recipientsTable)
        .set({ status: "viewed", viewedAt: new Date() })
        .where(eq(recipientsTable.token, token));
    }

    const fields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.recipientId, r.id));

    // When fully completed, return all signed fields so every recipient can see everyone's signatures
    let allSignedFields: typeof fields = [];
    if (doc?.status === "completed") {
      allSignedFields = await db
        .select()
        .from(signatureFieldsTable)
        .where(eq(signatureFieldsTable.documentId, r.documentId));
    }

    res.json({
      recipient: r,
      documentTitle: doc?.title ?? "Unknown Document",
      documentFilename: doc?.filename ?? "",
      alreadySigned: r.status === "signed",
      documentStatus: doc?.status ?? "sent",
      fields,
      allSignedFields,
    });
  } catch (err) {
    req.log.error({ err }, "get signing info error");
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

    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";

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

    // Persist field values for each placed field
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

    if (doc?.signingOrder === "sequential") {
      const allRecipients = await db
        .select()
        .from(recipientsTable)
        .where(eq(recipientsTable.documentId, r.documentId));

      allRecipients.sort((a, b) => a.signOrder - b.signOrder);
      const next = allRecipients.find((x) => x.signOrder === r.signOrder + 1 && x.status === "pending");

      if (next) {
        const baseUrl = getAppBaseUrl(req);
        await sendSigningEmail(next, doc, `${baseUrl}/sign/${next.token}`, null, null, "E-Sign Workflow");
      }
    }

    const allRecipients = await db
      .select()
      .from(recipientsTable)
      .where(eq(recipientsTable.documentId, r.documentId));

    if (allRecipients.every((x) => x.status === "signed")) {
      await db
        .update(documentsTable)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(documentsTable.id, r.documentId));
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

    if (signedRecipients.length < allRecipients.length) {
      res.status(403).json({ error: "The signed document will be available for download once all parties have completed signing." });
      return;
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

    const source = isGcsPath(doc.filepath)
      ? await getFileBuffer(doc.filepath)
      : doc.filepath;

    const pdfBytes = await buildSignedPdf(source, entries);
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

export default router;
