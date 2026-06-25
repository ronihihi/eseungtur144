import nodemailer from "nodemailer";
import { logger } from "../lib/logger.js";

// HTML-escape helper — prevents injecting markup via user-supplied values
// (doc title, sender name, custom message, reviewer names).
function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

// Lazy-initialised transporter — only created when SMTP is actually configured.
// Avoids a DNS lookup at startup and prevents a hardcoded host from masking a
// misconfigured SMTP_HOST env var.
let _transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter | null {
  if (!smtpConfigured()) return null;
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: {
        user: process.env.SMTP_USER || "",
        pass: process.env.SMTP_PASS || "",
      },
    });
  }
  return _transporter;
}

export async function sendSigningEmail(
  recipient: { teamName: string; email: string },
  doc: { title: string },
  signUrl: string,
  subject?: string | null,
  message?: string | null,
  senderName?: string | null
): Promise<void> {
  const t = getTransporter();
  if (!t) {
    logger.warn({ recipientEmail: recipient.email, signUrl }, "SMTP not configured — skipping email send");
    return;
  }

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
    <div style="background:#f8f9fa;border-radius:8px;padding:30px;margin-bottom:20px">
      <h2 style="color:#1a1a2e;margin-top:0">Document Signature Required</h2>
      <p style="color:#555;line-height:1.6">${esc(message) || "Please review and sign the document below."}</p>
      <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#888">Document</p>
        <p style="margin:4px 0 0;font-weight:bold;font-size:16px">${esc(doc.title)}</p>
      </div>
      <a href="${signUrl}" style="display:inline-block;background:#1a1a2e;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:10px">Review &amp; Sign Document &rarr;</a>
    </div>
    <p style="font-size:12px;color:#999;text-align:center">Sent by ${esc(senderName) || "E-Sign Workflow"}<br>This link is unique to you — do not share it.</p>
    </body></html>`;

  await t.sendMail({
    from: `"E-Sign Workflow" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: subject || `Action Required: Please sign "${doc.title}"`,
    html,
  });
}

export async function sendReviewInviteEmail(
  recipient: { teamName: string; email: string },
  doc: { title: string },
  reviewUrl: string,
  senderName?: string | null,
  customSubject?: string | null,
  customMessage?: string | null
): Promise<void> {
  const t = getTransporter();
  if (!t) {
    logger.warn({ recipientEmail: recipient.email, reviewUrl }, "SMTP not configured — skipping review invite email");
    return;
  }

  const messageHtml = customMessage
    ? `<p style="color:#555;line-height:1.6">${esc(customMessage)}</p>`
    : `<p style="color:#555;line-height:1.6">You have been asked to review the following document before it is sent for signatures. Please examine it carefully and either approve it or request changes.</p>`;

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
    <div style="background:#f8f9fa;border-radius:8px;padding:30px;margin-bottom:20px">
      <div style="display:inline-block;background:#1e3a5f;color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:bold;margin-bottom:16px;letter-spacing:0.05em">REVIEW REQUEST</div>
      <h2 style="color:#1a1a2e;margin-top:0">Document Review Required</h2>
      ${messageHtml}
      <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#888">Document</p>
        <p style="margin:4px 0 0;font-weight:bold;font-size:16px">${esc(doc.title)}</p>
      </div>
      <a href="${reviewUrl}" style="display:inline-block;background:#1e3a5f;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:10px">Review Document &rarr;</a>
    </div>
    <p style="font-size:12px;color:#999;text-align:center">Sent by ${esc(senderName) || "E-Sign Workflow"}<br>This link is unique to you — do not share it.</p>
    </body></html>`;

  await t.sendMail({
    from: `"E-Sign Workflow" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: customSubject || `Review Required: "${doc.title}"`,
    html,
  });
}

export async function sendPasswordResetEmail(
  name: string,
  email: string,
  resetUrl: string
): Promise<void> {
  const t = getTransporter();
  if (!t) {
    logger.warn({ email, resetUrl }, "SMTP not configured — skipping password reset email");
    return;
  }

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
    <div style="background:#f8f9fa;border-radius:8px;padding:30px;margin-bottom:20px">
      <h2 style="color:#1a1a2e;margin-top:0">Reset your password</h2>
      <p style="color:#555;line-height:1.6">Hi ${esc(name)},</p>
      <p style="color:#555;line-height:1.6">We received a request to reset your password. Click the button below to choose a new one. This link expires in <strong>1 hour</strong>.</p>
      <a href="${resetUrl}" style="display:inline-block;background:#1a1a2e;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:10px">Reset Password &rarr;</a>
      <p style="color:#888;font-size:13px;margin-top:24px">If you did not request a password reset, you can safely ignore this email — your password will not change.</p>
    </div>
    <p style="font-size:12px;color:#999;text-align:center">WorkflowSign &mdash; SOS Children's Villages Palestine</p>
    </body></html>`;

  await t.sendMail({
    from: `"E-Sign Workflow" <${process.env.SMTP_USER}>`,
    to: `${name} <${email}>`,
    subject: "Reset your WorkflowSign password",
    html,
  });
}

export async function sendSignUnlockEmail(
  recipient: { teamName: string; email: string },
  doc: { title: string },
  signUrl: string,
  approvedByNames: string[],
  customMessage?: string | null
): Promise<void> {
  const t = getTransporter();
  if (!t) {
    logger.warn({ recipientEmail: recipient.email, signUrl }, "SMTP not configured — skipping sign-unlock email");
    return;
  }

  const approvedByText = approvedByNames.length > 0
    ? `<p style="color:#555;line-height:1.6">This document has been reviewed and approved by: <strong>${esc(approvedByNames.join(", "))}</strong>. It is now ready for your signature.</p>`
    : `<p style="color:#555;line-height:1.6">This document has been reviewed and approved. It is now ready for your signature.</p>`;

  const customMessageHtml = customMessage
    ? `<p style="color:#555;line-height:1.6;border-top:1px solid #e0e0e0;margin-top:16px;padding-top:16px">${esc(customMessage)}</p>`
    : "";

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
    <div style="background:#f8f9fa;border-radius:8px;padding:30px;margin-bottom:20px">
      <div style="display:inline-block;background:#166534;color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:bold;margin-bottom:16px;letter-spacing:0.05em">&#10003; REVIEW APPROVED</div>
      <h2 style="color:#1a1a2e;margin-top:0">Ready to Sign</h2>
      ${approvedByText}
      ${customMessageHtml}
      <div style="background:white;border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#888">Document</p>
        <p style="margin:4px 0 0;font-weight:bold;font-size:16px">${esc(doc.title)}</p>
      </div>
      <a href="${signUrl}" style="display:inline-block;background:#166534;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:10px">Sign Document &rarr;</a>
    </div>
    <p style="font-size:12px;color:#999;text-align:center">This link is unique to you — do not share it.</p>
    </body></html>`;

  await t.sendMail({
    from: `"E-Sign Workflow" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: `Signature Required: "${doc.title}" has been approved`,
    html,
  });
}
