import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable } from "@workspace/db";
import type { Request, Response } from "express";
import { buildSignedPdf } from "./pdfSigner.js";
import { uploadToGcs, downloadFromGcs, streamFromGcs, isGcsPath } from "../lib/gcsStorage.js";

const execFileAsync = promisify(execFile);

const SOFFICE_CANDIDATES = [
  "soffice",
  "/usr/bin/soffice",
  "/usr/lib/libreoffice/program/soffice",
  "/nix/store/074580fbnhxwxldi7g30hz5ll1h471za-libreoffice-7.6.7.2-wrapped/bin/soffice",
];

let _sofficeCache: string | null = null;

async function findSoffice(): Promise<string> {
  if (_sofficeCache) return _sofficeCache;
  for (const candidate of SOFFICE_CANDIDATES) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 5_000 });
      _sofficeCache = candidate;
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("LibreOffice is not available in this environment. Please upload a PDF file instead.");
}

async function convertDocxToPdf(inputPath: string, outputDir: string): Promise<string> {
  const soffice = await findSoffice();
  const tmpProfile = path.join(os.tmpdir(), `lo-profile-${uuidv4()}`);
  try {
    await execFileAsync(
      soffice,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${tmpProfile}`,
        "--convert-to", "pdf",
        "--outdir", outputDir,
        inputPath,
      ],
      { env: { ...process.env, HOME: "/tmp" }, timeout: 60_000 }
    );
    const baseName = path.basename(inputPath, path.extname(inputPath));
    return path.join(outputDir, baseName + ".pdf");
  } finally {
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }
}

const router: IRouter = Router();

// Keep a local uploads dir for backward-compat with old local-path documents
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

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

    const result = await Promise.all(
      docs.map(async (doc) => {
        const recs = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, doc.id));
        return {
          ...doc,
          totalRecipients: recs.length,
          signedCount: recs.filter((r) => r.status === "signed").length,
        };
      })
    );

    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ documents: result });
  } catch (err) {
    req.log.error({ err }, "list documents error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/documents", requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileData, fileName, title, signing_order } = req.body as {
      fileData?: string;
      fileName?: string;
      title?: string;
      signing_order?: string;
    };

    if (!fileData || !fileName) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const allowed = [".pdf", ".docx", ".doc"];
    const ext = path.extname(fileName).toLowerCase();
    if (!allowed.includes(ext)) {
      res.status(400).json({ error: "Only PDF and Word documents are allowed" });
      return;
    }

    const buffer = Buffer.from(fileData, "base64");
    if (buffer.length > 50 * 1024 * 1024) {
      res.status(413).json({ error: "File exceeds the 50 MB limit" });
      return;
    }

    let pdfBuffer: Buffer;
    let finalFilename = fileName;

    if (ext === ".docx" || ext === ".doc") {
      // Write to temp dir, convert, read back, delete temp files
      const tmpDir = os.tmpdir();
      const tmpInput = path.join(tmpDir, `upload-${uuidv4()}${ext}`);
      fs.writeFileSync(tmpInput, buffer);
      try {
        const pdfPath = await convertDocxToPdf(tmpInput, tmpDir);
        pdfBuffer = fs.readFileSync(pdfPath);
        fs.unlinkSync(pdfPath);
        finalFilename = path.basename(fileName, ext) + ".pdf";
        req.log.info({ originalName: fileName }, "converted DOCX to PDF");
      } catch (convErr) {
        const msg = convErr instanceof Error ? convErr.message : "Could not convert Word document to PDF.";
        res.status(500).json({ error: msg });
        return;
      } finally {
        fs.rmSync(tmpInput, { force: true });
      }
    } else {
      pdfBuffer = buffer;
    }

    // Upload to GCS
    const objectName = `documents/${uuidv4()}.pdf`;
    const gcsPath = await uploadToGcs(pdfBuffer, objectName, "application/pdf");

    const newId = uuidv4();
    await db.insert(documentsTable).values({
      id: newId,
      title: title || fileName,
      filename: finalFilename,
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

router.get("/documents/:id/download", requireAuth, async (req: Request, res: Response) => {
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

    const recipients = await db.select().from(recipientsTable).where(eq(recipientsTable.documentId, id));
    const signedRecipients = recipients.filter((r) => r.status === "signed");

    const allFields = await db
      .select()
      .from(signatureFieldsTable)
      .where(eq(signatureFieldsTable.documentId, id));

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
