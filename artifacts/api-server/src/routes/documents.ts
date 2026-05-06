import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import { db, documentsTable, recipientsTable, signatureFieldsTable } from "@workspace/db";
import type { Request, Response } from "express";
import { buildSignedPdf } from "./pdfSigner.js";

const execFileAsync = promisify(execFile);
const SOFFICE = "/nix/store/074580fbnhxwxldi7g30hz5ll1h471za-libreoffice-7.6.7.2-wrapped/bin/soffice";

async function convertDocxToPdf(inputPath: string, outputDir: string): Promise<string> {
  const tmpProfile = `/tmp/lo-profile-${uuidv4()}`;
  try {
    await execFileAsync(
      SOFFICE,
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

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".docx", ".doc"];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and Word documents are allowed"));
    }
  },
});

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Please log in first" });
    return;
  }
  next();
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

router.post("/documents", requireAuth, upload.single("document"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const { title, signing_order } = req.body as { title?: string; signing_order?: string };

    let finalFilePath = req.file.path;
    let finalFilename = req.file.originalname;

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === ".docx" || ext === ".doc") {
      try {
        const pdfPath = await convertDocxToPdf(req.file.path, uploadsDir);
        fs.unlinkSync(req.file.path);
        finalFilePath = pdfPath;
        finalFilename = path.basename(req.file.originalname, ext) + ".pdf";
        req.log.info({ originalName: req.file.originalname, pdfPath }, "converted DOCX to PDF");
      } catch (convErr) {
        req.log.error({ convErr }, "DOCX to PDF conversion failed — keeping original");
      }
    }

    const newId = uuidv4();
    await db.insert(documentsTable).values({
      id: newId,
      title: title || req.file.originalname,
      filename: finalFilename,
      filepath: finalFilePath,
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
    if (!fs.existsSync(doc.filepath)) {
      res.status(404).json({ error: "File not found on disk" });
      return;
    }

    const ext = path.extname(doc.filepath).toLowerCase();
    const contentType = ext === ".pdf" ? "application/pdf" : "application/octet-stream";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "private, max-age=300");
    res.sendFile(path.resolve(doc.filepath));
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
    if (!doc || !fs.existsSync(doc.filepath)) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const ext = path.extname(doc.filepath).toLowerCase();
    if (ext !== ".pdf") {
      res.set("Content-Type", "application/octet-stream");
      res.set("Content-Disposition", `attachment; filename="${doc.filename}"`);
      res.sendFile(path.resolve(doc.filepath));
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

    const pdfBytes = await buildSignedPdf(doc.filepath, entries);
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
