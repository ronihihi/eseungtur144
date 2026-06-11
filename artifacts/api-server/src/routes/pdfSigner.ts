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

/**
 * Convert field coordinates from "displayed page space" (top-left origin, fractions
 * of the DISPLAYED page which may be rotated) to "pdf-lib drawing space" (bottom-left
 * origin, un-rotated MediaBox units).
 *
 * PDF rotation is stored in degrees CW. When a page has rotation R, the viewer
 * displays it rotated so the user sees a different orientation. Our field overlays
 * are placed as fractions of the DISPLAYED page, so we must undo the rotation to
 * get back to the drawing coordinate system.
 *
 * Returns { x, y, w, h } in pdf-lib units (bottom-left origin, un-rotated).
 */
function toDrawCoords(
  fx: number, fy: number, fw: number, fh: number, // fractional, display-space
  pw: number, ph: number,                          // un-rotated MediaBox size
  rotation: number                                 // 0 | 90 | 180 | 270 (CW degrees)
): { x: number; y: number; w: number; h: number } {
  switch (rotation) {
    case 90:
      // 90° CW: display top-left=(pw,ph), top-right=(pw,0), bottom-left=(0,ph), bottom-right=(0,0)
      // x_mb = pw*(1-fy),  y_mb = ph*(1-fx)
      // pdf-lib bottom-left corner of field box:
      return {
        x: pw * (1 - fy - fh),
        y: ph * (1 - fx - fw),
        w: fh * pw,
        h: fw * ph,
      };

    case 180:
      // 180°: display top-left=(pw,0), axes both flipped.
      // x_mb = pw*(1-fx),  y_mb = ph*fy
      return {
        x: pw * (1 - fx - fw),
        y: ph * fy,
        w: fw * pw,
        h: fh * ph,
      };

    case 270:
      // 270° CW (= 90° CCW): display top-left=(0,0), top-right=(0,ph), bottom-left=(pw,0)
      // x_mb = pw*fy,  y_mb = ph*fx
      return {
        x: pw * fy,
        y: ph * fx,
        w: fh * pw,
        h: fw * ph,
      };

    default: // 0 — standard top-left → bottom-left flip
      return {
        x: fx * pw,
        y: ph - fy * ph - fh * ph,
        w: fw * pw,
        h: fh * ph,
      };
  }
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
    const rotation = page.getRotation().angle; // 0 | 90 | 180 | 270

    const { x: bx, y: by, w: bw, h: bh } = toDrawCoords(
      entry.x, entry.y, entry.width, entry.height,
      pw, ph, rotation
    );

    if (entry.fieldType === "signature" || entry.fieldType === "initials") {
      const match = entry.fieldValue.match(/^data:image\/png;base64,(.+)$/);
      if (!match) continue;

      let pngImage;
      try {
        pngImage = await pdfDoc.embedPng(Buffer.from(match[1], "base64"));
      } catch {
        continue;
      }

      // Scale signature image to fit inside the field box with a small pad
      const sigPad = 4;
      const scale = Math.min((bw - sigPad * 2) / pngImage.width, (bh - sigPad * 2) / pngImage.height);
      const sigW = pngImage.width * scale;
      const sigH = pngImage.height * scale;
      page.drawImage(pngImage, {
        x: bx + (bw - sigW) / 2,
        y: by + (bh - sigH) / 2,
        width: sigW,
        height: sigH,
      });

      // Name + date printed just below the field box
      const fs = Math.max(5.5, Math.min(7.5, bw / 18));
      const lineH = fs + 2;
      const nameY = by - lineH;
      const dateY = by - lineH * 2;
      if (nameY > 4) {
        page.drawText(entry.signerName, { x: bx, y: nameY, size: fs, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      }
      if (dateY > 4) {
        page.drawText(`Signed: ${fmtDate(entry.signedAt)}`, { x: bx, y: dateY, size: fs, font, color: rgb(0.38, 0.38, 0.38) });
      }
    } else {
      // Date or text field — filled rectangle with text inside
      const value = entry.fieldType === "date" && !entry.fieldValue
        ? fmtDate(entry.signedAt)
        : entry.fieldValue;

      const fs = Math.max(7, Math.min(11, bh * 0.55));

      const fillColor = entry.fieldType === "date"
        ? rgb(0.92, 0.95, 1.0)
        : rgb(0.95, 1.0, 0.95);

      page.drawRectangle({
        x: bx, y: by, width: bw, height: bh,
        color: fillColor,
        borderColor: rgb(0.65, 0.75, 0.85),
        borderWidth: 0.75,
      });

      const textY = by + (bh - fs) / 2;
      page.drawText(value, {
        x: bx + 4, y: textY, size: fs, font: fontBold,
        color: rgb(0.08, 0.08, 0.35),
        maxWidth: bw - 8,
      });

      // Small label below
      const labelFs = Math.max(4.5, fs * 0.6);
      const labelY = by - labelFs - 1;
      if (labelY > 4) {
        const label = `${entry.signerName} · ${fmtDate(entry.signedAt)}`;
        page.drawText(label, { x: bx, y: labelY, size: labelFs, font, color: rgb(0.5, 0.5, 0.5) });
      }
    }
  }

  return pdfDoc.save();
}
