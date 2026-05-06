import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { readFileSync } from "fs";

export interface FieldEntry {
  fieldType: "signature" | "initials" | "date" | "text";
  fieldValue: string;
  signerName: string;
  signedAt: Date;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function fmtDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export async function buildSignedPdf(
  source: string | Buffer,
  entries: FieldEntry[]
): Promise<Uint8Array> {
  const pdfBytes = Buffer.isBuffer(source) ? source : readFileSync(source);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const entry of entries) {
    if (!entry.fieldValue) continue;

    const pageIdx = entry.page - 1;
    if (pageIdx < 0 || pageIdx >= pages.length) continue;
    const page = pages[pageIdx];
    const { width: pw, height: ph } = page.getSize();

    // Convert fractional coords (top-left origin) → pdf-lib coords (bottom-left origin)
    const fx = entry.x * pw;
    const fw = entry.width * pw;
    const fh = entry.height * ph;
    const fy = ph - entry.y * ph - fh;

    if (entry.fieldType === "signature" || entry.fieldType === "initials") {
      // Render as image
      const match = entry.fieldValue.match(/^data:image\/png;base64,(.+)$/);
      if (!match) continue;

      let pngImage;
      try {
        pngImage = await pdfDoc.embedPng(Buffer.from(match[1], "base64"));
      } catch {
        continue;
      }

      // Signature image centred and scaled to fit
      const sigPad = 4;
      const scale = Math.min((fw - sigPad * 2) / pngImage.width, (fh - sigPad * 2) / pngImage.height);
      const sigW = pngImage.width * scale;
      const sigH = pngImage.height * scale;
      page.drawImage(pngImage, {
        x: fx + (fw - sigW) / 2,
        y: fy + (fh - sigH) / 2,
        width: sigW, height: sigH,
      });

      // Name + date below the field box
      const fs = Math.max(5.5, Math.min(7.5, fw / 18));
      const lineH = fs + 2;
      const nameY = fy - lineH;
      const dateY = fy - lineH * 2;
      if (nameY > 4) {
        page.drawText(entry.signerName, { x: fx, y: nameY, size: fs, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      }
      if (dateY > 4) {
        page.drawText(`Signed: ${fmtDate(entry.signedAt)}`, { x: fx, y: dateY, size: fs, font, color: rgb(0.38, 0.38, 0.38) });
      }
    } else {
      // Text or date — render as plain text inside a box
      const value = entry.fieldType === "date" && !entry.fieldValue
        ? fmtDate(entry.signedAt)
        : entry.fieldValue;

      const fs = Math.max(7, Math.min(11, fh * 0.55));

      // Light filled rect
      const fillColor = entry.fieldType === "date"
        ? rgb(0.92, 0.95, 1.0)
        : rgb(0.95, 1.0, 0.95);

      page.drawRectangle({
        x: fx, y: fy, width: fw, height: fh,
        color: fillColor,
        borderColor: rgb(0.65, 0.75, 0.85),
        borderWidth: 0.75,
      });

      // Text centred vertically in the box
      const textY = fy + (fh - fs) / 2;
      page.drawText(value, {
        x: fx + 4, y: textY, size: fs, font: fontBold,
        color: rgb(0.08, 0.08, 0.35),
        maxWidth: fw - 8,
      });

      // Tiny label below
      const labelFs = Math.max(4.5, fs * 0.6);
      const labelY = fy - labelFs - 1;
      if (labelY > 4) {
        const label = `${entry.signerName} · ${fmtDate(entry.signedAt)}`;
        page.drawText(label, { x: fx, y: labelY, size: labelFs, font, color: rgb(0.5, 0.5, 0.5) });
      }
    }
  }

  return pdfDoc.save();
}
