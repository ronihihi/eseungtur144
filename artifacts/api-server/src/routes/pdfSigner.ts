import { PDFDocument, PDFPage, PDFFont, rgb, StandardFonts, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { createHash } from "crypto";

// createRequire bound to this module so require.resolve uses artifacts/api-server
// as the lookup root — works in both tsx (dev) and the esbuild ESM bundle (prod).
const _nodeRequire = createRequire(import.meta.url);

// ── Arabic font — lazy-loaded once, reused across all PDF builds ────────────
let _arabicRegular: Buffer | null | undefined;
let _arabicBold: Buffer | null | undefined;

function loadArabicFontBytes(): { regular: Buffer | null; bold: Buffer | null } {
  if (_arabicRegular !== undefined) return { regular: _arabicRegular, bold: _arabicBold ?? null };
  try {
    // require.resolve uses Node's module resolution from this package, so it
    // correctly finds the font in artifacts/api-server/node_modules/
    _arabicRegular = readFileSync(_nodeRequire.resolve("@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff"));
    _arabicBold    = readFileSync(_nodeRequire.resolve("@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff"));
  } catch {
    _arabicRegular = null;
    _arabicBold    = null;
  }
  return { regular: _arabicRegular, bold: _arabicBold ?? null };
}

/** True when the string contains any Arabic/RTL Unicode character. */
function hasArabic(s: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s);
}

/** Pick the Arabic font when the text contains Arabic; otherwise use the Latin font. */
function selectFont(s: string, latin: PDFFont, arabic: PDFFont): PDFFont {
  return hasArabic(s) ? arabic : latin;
}

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

export interface SignerRecord {
  name: string;
  email: string;
  signedAt: Date;
  ipAddress?: string | null;
}

export interface ReviewerRecord {
  name: string;
  email: string;
  reviewedAt: Date;
  ipAddress?: string | null;
  decision: "approved" | "changes_requested";
  note?: string | null;
}

export interface DocMeta {
  documentName: string;
  documentId: string;
  completedAt: Date;
}

function fmtDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
  }).format(date);
}

function fmtDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(date) + " UTC";
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "\u2026";
}

/**
 * pdf-lib's standard fonts (Helvetica/HelveticaBold) use WinAnsi (Windows-1252)
 * encoding, which covers only a subset of Unicode. Any character outside that
 * set — Arabic, Hebrew, CJK, emoji, etc. — will throw at render time.
 *
 * This function replaces every unsupported character with "?" so the PDF
 * always generates, even when names/filenames contain non-Latin text.
 */
const WIN_ANSI_EXTRAS = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017D, 0x017E,
  0x0192, 0x02C6, 0x02DC, 0x2013, 0x2014, 0x2018, 0x2019,
  0x201A, 0x201C, 0x201D, 0x201E, 0x2020, 0x2021, 0x2022,
  0x2026, 0x2030, 0x2039, 0x203A, 0x20AC, 0x2122,
]);

function safeText(s: string): string {
  return [...s].map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x0020 && cp <= 0x007e) ||   // printable ASCII
      (cp >= 0x00a0 && cp <= 0x00ff) ||   // Latin-1 supplement
      WIN_ANSI_EXTRAS.has(cp)              // WinAnsi extras (curly quotes, em-dash, etc.)
    ) {
      return ch;
    }
    return "?";
  }).join("");
}

/**
 * Strip C0 (0x00–0x1F) and C1 (0x7F–0x9F) control characters that no font
 * has glyphs for and that pdf-lib (or fontkit) will reject.  Safe to call
 * before drawText with any font, including custom Arabic fonts.
 */
function stripControlChars(s: string): string {
  return [...s].filter((ch) => {
    const cp = ch.codePointAt(0)!;
    return !((cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f));
  }).join("");
}

/**
 * Pick the right sanitizer depending on whether the string contains real
 * Arabic/RTL text:
 *  – Real Arabic → custom font (fontkit) → only strip control chars.
 *  – Everything else (Latin, Mojibake, mixed) → WinAnsi font → full safeText.
 */
function sanitizeForDraw(s: string): string {
  return hasArabic(s) ? stripControlChars(s) : safeText(s);
}

function generateCertId(documentId: string, completedAt: Date): string {
  const year = completedAt.getFullYear();
  const hash = createHash("sha256")
    .update(`${documentId}:${completedAt.toISOString()}`)
    .digest("hex")
    .toUpperCase()
    .slice(0, 6);
  return `ES-${year}-${hash}`;
}

/**
 * Convert field coordinates from "displayed page space" (top-left origin, fractions
 * of the DISPLAYED canvas) to "pdf-lib drawing space" (bottom-left origin,
 * un-rotated MediaBox units).
 */
function toDrawCoords(
  fx: number, fy: number, fw: number, fh: number,
  pw: number, ph: number,
  rotation: number
): { x: number; y: number; w: number; h: number } {
  switch (rotation) {
    case 90:
      return { x: fy * pw, y: fx * ph, w: fh * pw, h: fw * ph };
    case 180:
      return { x: pw * (1 - fx - fw), y: ph * (1 - fy - fh), w: fw * pw, h: fh * ph };
    case 270:
      return { x: pw * (1 - fy - fh), y: ph * (1 - fx - fw), w: fh * pw, h: fw * ph };
    default:
      return { x: fx * pw, y: ph * (1 - fy - fh), w: fw * pw, h: fh * ph };
  }
}

function displaySize(rotation: number, bw: number, bh: number): [number, number] {
  return rotation === 90 || rotation === 270 ? [bh, bw] : [bw, bh];
}

function imageAnchor(
  rotation: number,
  bx: number, by: number, bw: number, bh: number,
  drawW: number, drawH: number,
  imgFrac: number
): [number, number] {
  switch (rotation) {
    case 90: {
      const cx = bx + bw * (imgFrac / 2);
      const cy = by + bh / 2;
      return [cx + drawH / 2, cy - drawW / 2];
    }
    case 180: {
      const cx = bx + bw / 2;
      const cy = by + bh * (1 - imgFrac / 2);
      return [cx + drawW / 2, cy + drawH / 2];
    }
    case 270: {
      const cx = bx + bw * (1 - imgFrac / 2);
      const cy = by + bh / 2;
      return [cx - drawH / 2, cy + drawW / 2];
    }
    default: {
      const cx = bx + bw / 2;
      const cy = by + bh * (1 - imgFrac / 2);
      return [cx - drawW / 2, cy - drawH / 2];
    }
  }
}

function labelAt(
  pageRot: number,
  bx: number, by: number, bw: number, bh: number,
  fs: number,
  frac: number,
  pad = 3
): { x: number; y: number; rotate: ReturnType<typeof degrees> } {
  const shift = fs * 0.3;
  switch (pageRot) {
    case 90:
      return { x: bx + bw * frac + shift, y: by + pad, rotate: degrees(90) };
    case 180:
      return { x: bx + bw - pad, y: by + bh * (1 - frac) + shift, rotate: degrees(180) };
    case 270:
      return { x: bx + bw * (1 - frac) - shift, y: by + bh - pad, rotate: degrees(270) };
    default:
      return { x: bx + pad, y: by + bh * (1 - frac) - shift, rotate: degrees(0) };
  }
}

function dividerLine(
  pageRot: number,
  bx: number, by: number, bw: number, bh: number,
  imgFrac: number
): [number, number, number, number] {
  switch (pageRot) {
    case 90:  { const lx = bx + bw * imgFrac;       return [lx, by, lx, by + bh]; }
    case 180: { const ly = by + bh * (1 - imgFrac); return [bx, ly, bx + bw, ly]; }
    case 270: { const lx = bx + bw * (1 - imgFrac); return [lx, by, lx, by + bh]; }
    default:  { const ly = by + bh * (1 - imgFrac); return [bx, ly, bx + bw, ly]; }
  }
}

/**
 * Draw a small professional footer at the visual bottom of a page.
 * Handles all four page rotations.
 */
function drawPageFooter(
  page: PDFPage,
  pageNum: number,
  totalPages: number,
  certId: string,
  font: PDFFont,
): void {
  const { width: pw, height: ph } = page.getSize();
  const rotation = page.getRotation().angle;
  const fs = 6.5;
  const vMargin = 10;   // distance from visual-bottom edge
  const hPad = 22;      // distance from visual-left/right edge
  const lc = rgb(0.75, 0.75, 0.75);
  const tc = rgb(0.48, 0.48, 0.48);

  const leftText = "Electronically signed via SOS Village - Palestine E-Signature System";
  const rightText = `Cert: ${certId}  \u00B7  Page ${pageNum} of ${totalPages}`;

  switch (rotation) {
    case 90: {
      // Visual bottom = MediaBox left side (low x)
      const lineX = vMargin + fs + 3;
      page.drawLine({ start: { x: lineX, y: hPad }, end: { x: lineX, y: ph - hPad }, thickness: 0.4, color: lc });
      page.drawText(leftText, { x: lineX - fs + 2, y: hPad, size: fs, font, color: tc, rotate: degrees(90) });
      page.drawText(rightText, { x: lineX - fs + 2, y: ph - hPad, size: fs, font, color: tc, rotate: degrees(90) });
      break;
    }
    case 180: {
      // Visual bottom = MediaBox top side (high y)
      const lineY = ph - vMargin - fs - 3;
      page.drawLine({ start: { x: hPad, y: lineY }, end: { x: pw - hPad, y: lineY }, thickness: 0.4, color: lc });
      page.drawText(leftText, { x: pw - hPad, y: lineY + 1, size: fs, font, color: tc, rotate: degrees(180) });
      const rightX = hPad + rightText.length * fs * 0.52;
      page.drawText(rightText, { x: Math.min(pw / 2 - 10, rightX), y: lineY + 1, size: fs, font, color: tc, rotate: degrees(180) });
      break;
    }
    case 270: {
      // Visual bottom = MediaBox right side (high x)
      const lineX = pw - vMargin - fs - 3;
      page.drawLine({ start: { x: lineX, y: hPad }, end: { x: lineX, y: ph - hPad }, thickness: 0.4, color: lc });
      page.drawText(leftText, { x: lineX + 1, y: ph - hPad, size: fs, font, color: tc, rotate: degrees(270) });
      page.drawText(rightText, { x: lineX + 1, y: hPad + rightText.length * fs * 0.52, size: fs, font, color: tc, rotate: degrees(270) });
      break;
    }
    default: { // R=0
      const lineY = vMargin + fs + 3;
      page.drawLine({ start: { x: hPad, y: lineY }, end: { x: pw - hPad, y: lineY }, thickness: 0.4, color: lc });
      page.drawText(leftText, { x: hPad, y: vMargin, size: fs, font, color: tc });
      const rightX = pw - hPad - rightText.length * fs * 0.52;
      page.drawText(rightText, { x: Math.max(pw / 2 + 20, rightX), y: vMargin, size: fs, font, color: tc });
      break;
    }
  }
}

/**
 * Append a full audit certificate page at the end of the PDF.
 */
async function addAuditPage(
  pdfDoc: PDFDocument,
  doc: DocMeta,
  signers: SignerRecord[],
  certId: string,
  docHash: string,
  font: PDFFont,
  fontBold: PDFFont,
  fontArabic: PDFFont,
  fontArabicBold: PDFFont,
  pageNum: number,
  totalPages: number,
  reviewers?: ReviewerRecord[],
): Promise<void> {
  const page = pdfDoc.addPage([595.28, 841.89]);
  const pw = 595.28;
  const ph = 841.89;
  const margin = 40;
  const contentW = pw - margin * 2;

  const brandBlue   = rgb(0.07, 0.22, 0.44);
  const lightBlue   = rgb(0.91, 0.94, 0.98);
  const darkText    = rgb(0.08, 0.08, 0.08);
  const midText     = rgb(0.35, 0.35, 0.35);
  const lightText   = rgb(0.52, 0.52, 0.52);
  const lineGray    = rgb(0.82, 0.82, 0.82);
  const white       = rgb(1, 1, 1);
  const successGreen = rgb(0.10, 0.50, 0.20);

  // ── Header bar ─────────────────────────────────────────────────────────────
  const headerH = 72;
  page.drawRectangle({ x: 0, y: ph - headerH, width: pw, height: headerH, color: brandBlue });
  page.drawText("E-SIGNATURE CERTIFICATE", {
    x: margin, y: ph - 34, size: 17, font: fontBold, color: white,
  });
  page.drawText("SOS Village - Palestine  \u00B7  Electronic Signature System", {
    x: margin, y: ph - 53, size: 8.5, font, color: rgb(0.74, 0.84, 0.94),
  });

  let y = ph - headerH - 22;

  // ── Section helpers ─────────────────────────────────────────────────────────
  const sectionLabel = (text: string) => {
    page.drawText(text, { x: margin, y, size: 7.5, font: fontBold, color: brandBlue });
    y -= 5;
    page.drawLine({
      start: { x: margin, y }, end: { x: pw - margin, y },
      thickness: 0.8, color: brandBlue,
    });
    y -= 14;
  };

  const kv = (label: string, value: string, valueColor = darkText, bold = false) => {
    page.drawText(label, { x: margin, y, size: 8.5, font: fontBold, color: midText });
    const safeVal = sanitizeForDraw(value);
    const vFont = bold
      ? selectFont(safeVal, fontBold, fontArabicBold)
      : selectFont(safeVal, font, fontArabic);
    page.drawText(safeVal, { x: margin + 135, y, size: 8.5, font: vFont, color: valueColor });
    y -= 16;
  };

  // ── Document Information ───────────────────────────────────────────────────
  sectionLabel("DOCUMENT INFORMATION");
  kv("Document Name:", truncate(doc.documentName, 52));
  kv("Document ID:", doc.documentId);
  kv("Signing Status:", "COMPLETED", successGreen, true);
  kv("Certificate ID:", certId, brandBlue, true);
  kv("Completed:", fmtDateTime(doc.completedAt));
  y -= 8;

  // ── Review Record (only if reviewers were involved) ─────────────────────────
  if (reviewers && reviewers.length > 0) {
    sectionLabel("REVIEW RECORD");
    const rvColX = [margin, margin + 130, margin + 280, margin + 390];
    const rvHeaders = ["REVIEWER NAME", "EMAIL ADDRESS", "REVIEWED AT (UTC)", "DECISION"];
    const rowH = 18;

    page.drawRectangle({ x: margin, y: y - rowH + 5, width: contentW, height: rowH, color: lightBlue });
    rvHeaders.forEach((h, i) => {
      page.drawText(h, { x: rvColX[i] + 3, y: y - 3, size: 6.8, font: fontBold, color: brandBlue });
    });
    y -= rowH;

    for (const rv of reviewers) {
      // Main reviewer row
      const decisionText = rv.decision === "approved" ? "APPROVED" : "CHANGES REQUESTED";
      const decisionColor = rv.decision === "approved" ? successGreen : rgb(0.75, 0.2, 0.1);
      const cells = [
        truncate(sanitizeForDraw(rv.name), 22),
        truncate(sanitizeForDraw(rv.email), 26),
        fmtDateTime(rv.reviewedAt),
      ];
      cells.forEach((c, ci) => {
        const cellFont = selectFont(c, font, fontArabic);
        page.drawText(c, { x: rvColX[ci] + 3, y: y - 3, size: 7.5, font: cellFont, color: darkText });
      });
      page.drawText(decisionText, { x: rvColX[3] + 3, y: y - 3, size: 7.5, font: fontBold, color: decisionColor });
      y -= rowH;

      // Note sub-row (full width) if present
      if (rv.note) {
        const notePrefix = "Note: ";
        const maxNoteChars = 110;
        const safeNote = sanitizeForDraw(rv.note);
        const noteText = notePrefix + (safeNote.length > maxNoteChars ? safeNote.slice(0, maxNoteChars - 1) + "\u2026" : safeNote);
        const noteH = 16;
        page.drawRectangle({ x: margin, y: y - noteH + 5, width: contentW, height: noteH, color: rgb(1.0, 0.98, 0.92) });
        const noteFont = selectFont(safeNote, font, fontArabic);
        page.drawText(noteText, { x: margin + 6, y: y - 4, size: 7.5, font: noteFont, color: rgb(0.45, 0.28, 0.0) });
        y -= noteH;
      }

      page.drawLine({
        start: { x: margin, y: y + 5 }, end: { x: pw - margin, y: y + 5 },
        thickness: 0.3, color: lineGray,
      });
    }
    y -= 12;
  }

  // ── Signing Record ─────────────────────────────────────────────────────────
  sectionLabel("SIGNING RECORD");

  // Column positions: Name(115) | Email(140) | Signed At(100) | IP(85) | Method(75) = 515
  const colX = [margin, margin + 115, margin + 255, margin + 355, margin + 440];
  const colHeaders = ["SIGNER NAME", "EMAIL ADDRESS", "SIGNED AT (UTC)", "IP ADDRESS", "METHOD"];
  const rowH = 18;

  // Header row background
  page.drawRectangle({ x: margin, y: y - rowH + 5, width: contentW, height: rowH, color: lightBlue });
  colHeaders.forEach((h, i) => {
    page.drawText(h, { x: colX[i] + 3, y: y - 3, size: 6.8, font: fontBold, color: brandBlue });
  });
  y -= rowH;

  for (const [i, s] of signers.entries()) {
    if (i % 2 === 1) {
      page.drawRectangle({ x: margin, y: y - rowH + 5, width: contentW, height: rowH, color: rgb(0.97, 0.97, 0.97) });
    }
    // Show only the first (real client) IP — strip proxy hops after the first comma
    const firstIp = s.ipAddress ? s.ipAddress.split(",")[0].trim() : "\u2014";
    const cells = [
      truncate(sanitizeForDraw(s.name), 18),
      truncate(sanitizeForDraw(s.email), 24),
      fmtDateTime(s.signedAt),
      firstIp,
      "Email Verification",
    ];
    cells.forEach((c, ci) => {
      const cellFont = selectFont(c, font, fontArabic);
      page.drawText(c, { x: colX[ci] + 3, y: y - 3, size: 7.5, font: cellFont, color: darkText });
    });
    y -= rowH;
    page.drawLine({
      start: { x: margin, y: y + 5 }, end: { x: pw - margin, y: y + 5 },
      thickness: 0.3, color: lineGray,
    });
  }
  y -= 12;

  // ── Verification ───────────────────────────────────────────────────────────
  sectionLabel("VERIFICATION & INTEGRITY");
  kv("Authentication Method:", "Unique Email Link");
  kv("Document SHA-256:", docHash.toLowerCase().slice(0, 40) + "\u2026");
  kv("Certificate ID:", certId);
  y -= 6;

  // Legal notice box
  const noticeLines = [
    "This certificate is automatically generated proof that the above document was electronically signed.",
    `All signatures were collected via SOS Village - Palestine E-Signature System on ${fmtDate(doc.completedAt)}.`,
    "The SHA-256 hash uniquely identifies this document at the moment signing was completed.",
  ];
  const noticeH = noticeLines.length * 14 + 14;
  page.drawRectangle({
    x: margin, y: y - noticeH, width: contentW, height: noticeH,
    color: lightBlue, borderColor: rgb(0.72, 0.80, 0.92), borderWidth: 0.5,
  });
  noticeLines.forEach((line, li) => {
    page.drawText(line, { x: margin + 8, y: y - 11 - li * 14, size: 7.5, font, color: midText });
  });
  y -= noticeH + 12;

  // ── Page footer ────────────────────────────────────────────────────────────
  page.drawLine({
    start: { x: margin, y: 28 }, end: { x: pw - margin, y: 28 },
    thickness: 0.4, color: lineGray,
  });
  page.drawText(
    "This document is an electronically generated certificate and does not require a handwritten signature.",
    { x: margin, y: 16, size: 6.5, font, color: lightText }
  );
  const certLabel = `${certId}  \u00B7  Page ${pageNum} of ${totalPages}`;
  page.drawText(certLabel, {
    x: pw - margin - certLabel.length * 3.55, y: 16,
    size: 6.5, font: fontBold, color: lightText,
  });
}

export async function buildSignedPdf(
  source: string | Buffer,
  entries: FieldEntry[],
  meta?: { doc: DocMeta; signers: SignerRecord[]; reviewers?: ReviewerRecord[] }
): Promise<Uint8Array> {
  const pdfBytes = Buffer.isBuffer(source) ? source : readFileSync(source);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Arabic fonts — embedded once per PDF; fall back to Helvetica if unavailable
  const { regular: arabicRegularBytes, bold: arabicBoldBytes } = loadArabicFontBytes();
  const fontArabic     = arabicRegularBytes ? await pdfDoc.embedFont(arabicRegularBytes) : font;
  const fontArabicBold = arabicBoldBytes    ? await pdfDoc.embedFont(arabicBoldBytes)    : fontBold;

  // ── Draw field overlays ──────────────────────────────────────────────────
  for (const entry of entries) {
    if (!entry.fieldValue) continue;

    const pageIdx = entry.page - 1;
    if (pageIdx < 0 || pageIdx >= pages.length) continue;
    const page = pages[pageIdx];
    const { width: pw, height: ph } = page.getSize();
    const rotation = page.getRotation().angle;

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

      const [dispW, dispH] = displaySize(rotation, bw, bh);
      const imgFrac = 0.65;

      const scale = Math.min(
        (dispW * 0.70) / pngImage.width,
        (dispH * 0.60) / pngImage.height
      );
      const drawW = Math.max(1, pngImage.width * scale);
      const drawH = Math.max(1, pngImage.height * scale);

      const [imgX, imgY] = imageAnchor(rotation, bx, by, bw, bh, drawW, drawH, imgFrac);
      page.drawImage(pngImage, {
        x: imgX, y: imgY,
        width: drawW, height: drawH,
        rotate: degrees(rotation),
      });

      const [x1, y1, x2, y2] = dividerLine(rotation, bx, by, bw, bh, imgFrac);
      page.drawLine({
        start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
        thickness: 0.5, color: rgb(0.75, 0.75, 0.75),
      });

      const nameFs = Math.max(4.5, Math.min(6.5, Math.min(dispW, dispH) * 0.14));
      const nameOpts = labelAt(rotation, bx, by, bw, bh, nameFs, 0.76, 3);
      const safeName = sanitizeForDraw(entry.signerName);
      page.drawText(safeName, {
        x: nameOpts.x, y: nameOpts.y, size: nameFs,
        rotate: nameOpts.rotate,
        font: selectFont(safeName, fontBold, fontArabicBold),
        color: rgb(0.1, 0.1, 0.1),
      });

      const dateFs = Math.max(4, Math.min(5.5, Math.min(dispW, dispH) * 0.11));
      const dateOpts = labelAt(rotation, bx, by, bw, bh, dateFs, 0.88, 3);
      page.drawText(`Signed: ${fmtDate(entry.signedAt)}`, {
        x: dateOpts.x, y: dateOpts.y, size: dateFs,
        rotate: dateOpts.rotate, font,
        color: rgb(0.38, 0.38, 0.38),
      });

    } else {
      const value = entry.fieldType === "date" && !entry.fieldValue
        ? fmtDate(entry.signedAt)
        : entry.fieldValue;

      const [dispW, dispH] = displaySize(rotation, bw, bh);
      const fs = Math.max(7, Math.min(11, Math.min(dispW, dispH) * 0.45));
      const opts = labelAt(rotation, bx, by, bw, bh, fs, 0.5, 4);
      page.drawText(value, {
        x: opts.x, y: opts.y, size: fs,
        rotate: opts.rotate,
        font: selectFont(value, fontBold, fontArabicBold),
        color: rgb(0.08, 0.08, 0.35),
      });
    }
  }

  // ── Footer + audit page (only when signing metadata is provided) ──────────
  if (meta) {
    const { doc, signers } = meta;
    const certId = generateCertId(doc.documentId, doc.completedAt);
    const docHash = createHash("sha256").update(pdfBytes).digest("hex");

    // Footer on every original page
    const originalPageCount = pages.length;
    const totalPages = originalPageCount + 1; // +1 for the audit page

    for (let i = 0; i < originalPageCount; i++) {
      drawPageFooter(pages[i], i + 1, totalPages, certId, font);
    }

    // Audit certificate page at the end
    await addAuditPage(pdfDoc, doc, signers, certId, docHash, font, fontBold, fontArabic, fontArabicBold, totalPages, totalPages, meta.reviewers);
  }

  return pdfDoc.save();
}
