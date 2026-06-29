import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import { eq, and, inArray } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable } from "@workspace/db";
import type { Request, Response } from "express";
import { buildSignedPdf, SignerRecord, ReviewerRecord, DocMeta } from "./pdfSigner.js";
import { uploadToGcs, downloadFromGcs, streamFromGcs, isGcsPath, deleteFromGcs, StorageFileNotFoundError } from "../lib/gcsStorage.js";
import { uploadRateLimit, downloadRateLimit } from "../lib/rateLimiters.js";

const router: IRouter = Router();

// LOAD-B4: Concurrency guard — each in-flight upload pins up to 50 MB of heap.
// Reject early rather than OOM the instance under bulk concurrent uploads.
let _activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 3;

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    req.resume();
    res.status(401).json({ error: "Please log in first" });
    return;
  }
  next();
}

async function getFileBuffer(filepath: string): Promise<Buffer> {
  if (isGcsPath(filepath)) {
    return downloadFromGcs(filepath);
  }
  return fs.promises.readFile(filepath);
}

async function fileExists(filepath: string): Promise<boolean> {
  if (isGcsPath(filepath)) return true;
  return fs.existsSync(filepath);
}

router.get("/documents", requireAuth, async (req: Request, res: Response) => {
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.uploadedBy, req.session.userId!));

    // HARD-7: Single recipients query instead of N+1.
    const docIds = docs.map((d) => d.id);
    const allRecs = docIds.length
      ? await db.select().from(recipientsTable).where(inArray(recipientsTable.documentId, docIds))
      : [];
    const byDoc = new Map<string, typeof allRecs>();
    for (const r of allRecs) {
      const list = byDoc.get(r.documentId) ?? [];
      list.push(r);
      byDoc.set(r.documentId, list);
    }

    const result = docs.map((doc) => {
      const recs = byDoc.get(doc.id) ?? [];
      return {
        ...doc,
        totalRecipients: recs.length,
        signedCount: recs.filter((r) => r.status === "signed").length,
      };
    });

    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ documents: result });
  } catch (err) {
    req.log.error({ err }, "list documents error");
    res.status(500).json({ error: "Internal server error" });
  }
});

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

router.post("/documents", requireAuth, uploadRateLimit, multerUpload.single("file"), async (req: Request, res: Response) => {
  if (_activeUploads >= MAX_CONCURRENT_UPLOADS) {
    res.status(429).json({ error: "Too many uploads in progress — please try again in a moment" });
    return;
  }
  _activeUploads++;
  try {
    const uploadedFile = req.file;
    const { title, signing_order } = req.body as { title?: string; signing_order?: string };

    if (!uploadedFile) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const fileName = uploadedFile.originalname;
    const pdfBuffer: Buffer = uploadedFile.buffer;

    // HARD-9: Verify magic bytes — multer checks extension, but a crafted upload
    // could still be a non-PDF with a .pdf extension.
    if (pdfBuffer.length < 5 || !pdfBuffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
      res.status(400).json({ error: "File is not a valid PDF" });
      return;
    }

    // Upload to GCS
    const objectName = `documents/${uuidv4()}.pdf`;
    const gcsPath = await uploadToGcs(pdfBuffer, objectName, "application/pdf");

    const newId = uuidv4();
    await db.insert(documentsTable).values({
      id: newId,
      title: title || fileName,
      filename: fileName,
      filepath: gcsPath,
      uploadedBy: req.session.userId!,
      uploaderName: req.session.userName!,
      signingOrder: signing_order === "sequential" ? "sequential" : "simultaneous",
      status: "draft",
    });
    res.json({ success: true, documentId: newId });
  } catch (err) {
    req.log.error({ err }, "upload document error");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    _activeUploads--;
  }
});

router.get("/documents/:id", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
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

    const fields = await db.select().from(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));

    res.json({
      document: {
        ...doc,
        totalRecipients: recipients.length,
        signedCount: recipients.filter((r) => r.status === "signed").length,
      },
      recipients,
      fields,
    });
  } catch (err) {
    req.log.error({ err }, "get document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/documents/:id/file", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
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
    if (!(await fileExists(doc.filepath))) {
      res.status(404).json({ error: "File not found" });
      return;
    }

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
      req.log.warn({ err }, "document file not found in storage");
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
    req.log.error({ err }, "serve document file error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/documents/:id/fields", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const fields = await db.select().from(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));
    res.json({ fields });
  } catch (err) {
    req.log.error({ err }, "get fields error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/documents/:id/fields", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);

    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const { fields } = req.body as {
      fields: Array<{ recipientId: string; page: number; x: number; y: number; width: number; height: number; fieldType?: string }>;
    };

    if (!Array.isArray(fields)) {
      res.status(400).json({ error: "fields must be an array" });
      return;
    }

    // HARD-5: Validate fractional coordinates to prevent out-of-range values
    // reaching the DB and being rendered off-screen.
    const inRange01 = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1;
    for (const f of fields) {
      if (
        !inRange01(f.x) || !inRange01(f.y) || !inRange01(f.width) || !inRange01(f.height) ||
        f.x + f.width > 1.001 || f.y + f.height > 1.001 ||
        !Number.isInteger(f.page) || f.page < 1
      ) {
        res.status(400).json({ error: "Invalid field geometry — coordinates must be in 0–1 fractional range" });
        return;
      }
    }

    await db.delete(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));

    if (fields.length > 0) {
      await db.insert(signatureFieldsTable).values(
        fields.map((f) => ({
          id: uuidv4(),
          documentId: id,
          recipientId: f.recipientId,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          fieldType: f.fieldType ?? "signature",
        }))
      );
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "save fields error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/documents/:id/download", requireAuth, downloadRateLimit, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    const doc = docs[0];
    if (!doc || !(await fileExists(doc.filepath))) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const safeName = doc.filename.replace(/[^a-z0-9.\-_]/gi, "_");

    // Fast path: use the pre-sealed PDF already stored in GCS when available.
    // This is set once all signers have completed, so it always has every signature.
    if (doc.sealedPdfPath) {
      try {
        const sealedBuf = await downloadFromGcs(doc.sealedPdfPath);
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="${safeName}"`);
        res.set("Content-Length", String(sealedBuf.byteLength));
        res.send(sealedBuf);
        return;
      } catch {
        req.log.warn("sealed PDF not found in GCS, falling back to on-demand generation");
      }
    }

    // Run all three DB queries + GCS download in parallel
    const [recipients, allFields, fileSource] = await Promise.all([
      db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id)),
      db.select().from(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id)),
      isGcsPath(doc.filepath) ? getFileBuffer(doc.filepath) : Promise.resolve(doc.filepath),
    ]);

    const signedRecipients = recipients.filter((r) => r.status === "signed");
    const reviewerRecipients = recipients.filter((r) => r.requiresReview && r.reviewStatus);

    const entries = signedRecipients.flatMap((r) => {
      const recipientFields = allFields.filter((f) => f.recipientId === r.id);
      // Use actual signedAt — never fall back to current time (that would show wrong timestamp)
      const signedAt = r.signedAt ? new Date(r.signedAt) : null;
      if (!signedAt) return [];
      const signerName = r.signerName || r.teamName || r.email;
      return recipientFields.flatMap((f) => {
        const ft = (f.fieldType || "signature") as "signature" | "initials" | "date" | "text";
        if (f.fieldValue) {
          return [{ fieldType: ft, fieldValue: f.fieldValue, signerName, signedAt, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }];
        }
        // Only stamp placeholder for drawn fields where no image was captured.
        // date/text fields with no value are intentionally blank — omit them.
        if (ft === "signature" || ft === "initials") {
          return [{ fieldType: "text" as const, fieldValue: "Electronically Signed", signerName, signedAt, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }];
        }
        return [];
      });
    });

    const signerRecords: SignerRecord[] = signedRecipients
      .filter((r) => r.signedAt)
      .map((r) => ({
        name: r.signerName || r.teamName || r.email,
        email: r.email,
        signedAt: new Date(r.signedAt!),
        ipAddress: r.ipAddress,
      }));

    const reviewerRecords: ReviewerRecord[] = reviewerRecipients
      .filter((r) => r.reviewedAt)
      .map((r) => ({
        name: r.signerName || r.teamName,
        email: r.email,
        reviewedAt: new Date(r.reviewedAt!),
        ipAddress: r.ipAddress,
        decision: (r.reviewStatus === "approved" ? "approved" : "changes_requested") as "approved" | "changes_requested",
        note: r.reviewNote ?? null,
      }));

    // completedAt = latest actual signature time (never fallback to now)
    const completedAt = signerRecords.reduce<Date>((latest, r) => {
      return r.signedAt > latest ? r.signedAt : latest;
    }, new Date(0));

    const docMeta: DocMeta = {
      documentName: doc.filename,
      documentId: doc.id,
      completedAt: completedAt.getTime() === 0 ? new Date() : completedAt,
    };

    const pdfBytes = await buildSignedPdf(fileSource, entries, {
      doc: docMeta,
      signers: signerRecords,
      reviewers: reviewerRecords,
    });
    const pdfBuf = Buffer.from(pdfBytes);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${safeName}"`);
    res.set("Content-Length", String(pdfBuf.byteLength));
    res.send(pdfBuf);

    // STAB-C2 / LOAD-B5: Self-heal — persist the regenerated PDF so subsequent
    // downloads use the fast sealed-path and don't re-run pdf-lib every time.
    if (!doc.sealedPdfPath && doc.status === "completed") {
      const sealedObjectName = `sealed/${doc.id}.pdf`;
      uploadToGcs(pdfBuf, sealedObjectName, "application/pdf")
        .then((sealedPath) =>
          db.update(documentsTable).set({ sealedPdfPath: sealedPath }).where(eq(documentsTable.id, id))
        )
        .catch((err) => req.log.warn({ err }, "self-heal sealed PDF upload failed"));
    }
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

router.delete("/documents/:id", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
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
    if (doc.status === "sent" || doc.status === "completed") {
      res.status(409).json({ error: "Documents that have been sent for signing or are completed cannot be deleted." });
      return;
    }

    await db.delete(signatureFieldsTable).where(eq(signatureFieldsTable.documentId, id));
    await db.delete(recipientsTable).where(eq(recipientsTable.documentId, id));
    await db.delete(documentsTable).where(eq(documentsTable.id, id));

    // S-3: Delete GCS objects so orphaned files don't accumulate in storage.
    const gcsDeletes: Promise<void>[] = [];
    if (doc.filepath && isGcsPath(doc.filepath)) {
      gcsDeletes.push(deleteFromGcs(doc.filepath));
    }
    if (doc.sealedPdfPath && isGcsPath(doc.sealedPdfPath)) {
      gcsDeletes.push(deleteFromGcs(doc.sealedPdfPath));
    }
    await Promise.allSettled(gcsDeletes);

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "delete document error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/documents/:id/status", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.uploadedBy, req.session.userId!)))
      .limit(1);
    if (docs.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const recipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id));
    recipients.sort((a, b) => a.signOrder - b.signOrder);
    res.json({ recipients, status: docs[0].status });
  } catch (err) {
    req.log.error({ err }, "get document status error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
