import nodemailer from "nodemailer";
import { logger } from "../lib/logger.js";

// HTML-escape helper — prevents injecting markup via user-supplied values
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

// ── Shared email shell ────────────────────────────────────────────────────────

function emailShell(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WorkflowSign</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#1a202c;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">

        <!-- Header -->
        <tr>
          <td style="background:#1a3a5c;border-radius:12px 12px 0 0;padding:28px 36px;text-align:center;">
            <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">
              &#9998;&nbsp; E-Signature Request
            </span>
            <br/>
            <span style="font-size:13px;color:#a8c4e0;letter-spacing:0.3px;margin-top:4px;display:inline-block;">
              SOS Children&rsquo;s Villages Palestine
            </span>
          </td>
        </tr>

        <!-- Body card -->
        <tr>
          <td style="background:#ffffff;padding:36px 36px 28px;border-left:1px solid #dde3ea;border-right:1px solid #dde3ea;">
            ${body}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f7f9fb;border:1px solid #dde3ea;border-top:none;border-radius:0 0 12px 12px;padding:20px 36px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#8a95a3;line-height:1.7;">
              This link is <strong>unique to you</strong> — do not forward or share it.<br/>
              &copy; SOS Children&rsquo;s Villages Palestine &mdash; Secure E-Signatures
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Signature-request email ────────────────────────────────────────────────────

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

  const personalNoteHtml = message?.trim()
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr>
          <td style="background:#f0f7ff;border-left:4px solid #1a3a5c;border-radius:0 8px 8px 0;padding:16px 20px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#1a3a5c;">
              Message from ${esc(senderName) || "the sender"}
            </p>
            <p style="margin:0;font-size:14px;color:#2d3748;line-height:1.7;white-space:pre-wrap;">${esc(message.trim())}</p>
          </td>
        </tr>
      </table>`
    : "";

  const body = `
    <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#1a3a5c;text-transform:uppercase;letter-spacing:0.07em;">Signature Request</p>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a202c;line-height:1.3;">Your signature is required</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#4a5568;line-height:1.7;">
      Hi <strong>${esc(recipient.teamName)}</strong>,<br/>
      <strong>${esc(senderName) || "Someone"}</strong> has requested your signature on the following document.
    </p>

    ${personalNoteHtml}

    <!-- Document card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;background:#f7f9fb;border:1px solid #dde3ea;border-radius:8px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#8a95a3;">Document</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:#1a202c;">${esc(doc.title)}</p>
        </td>
      </tr>
    </table>

    <!-- CTA -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td align="center">
          <a href="${signUrl}"
             style="display:inline-block;background:#1a3a5c;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:8px;letter-spacing:0.3px;">
            Review &amp; Sign Document &rarr;
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:12px;color:#8a95a3;text-align:center;line-height:1.6;">
      Or copy this link into your browser:<br/>
      <span style="color:#1a3a5c;word-break:break-all;">${signUrl}</span>
    </p>`;

  await t.sendMail({
    from: `"SOS Children's Villages Palestine" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: subject || `Signature Request: ${doc.title}`,
    html: emailShell(body),
  });
}

// ── Review-invite email ───────────────────────────────────────────────────────

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

  const reviewNoteHtml = customMessage?.trim()
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr>
          <td style="background:#f0f7ff;border-left:4px solid #2563eb;border-radius:0 8px 8px 0;padding:16px 20px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#1e40af;">
              Message from ${esc(senderName) || "the sender"}
            </p>
            <p style="margin:0;font-size:14px;color:#2d3748;line-height:1.7;white-space:pre-wrap;">${esc(customMessage.trim())}</p>
          </td>
        </tr>
      </table>`
    : "";

  const body = `
    <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#2563eb;text-transform:uppercase;letter-spacing:0.07em;">Review Request</p>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a202c;line-height:1.3;">Your review is required</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#4a5568;line-height:1.7;">
      Hi <strong>${esc(recipient.teamName)}</strong>,<br/>
      <strong>${esc(senderName) || "Someone"}</strong> has asked you to review the following document before it is sent for signatures. Please examine it carefully and approve or request changes.
    </p>

    ${reviewNoteHtml}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;background:#f7f9fb;border:1px solid #dde3ea;border-radius:8px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#8a95a3;">Document</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:#1a202c;">${esc(doc.title)}</p>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td align="center">
          <a href="${reviewUrl}"
             style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:8px;letter-spacing:0.3px;">
            Review Document &rarr;
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:12px;color:#8a95a3;text-align:center;line-height:1.6;">
      Or copy this link into your browser:<br/>
      <span style="color:#2563eb;word-break:break-all;">${reviewUrl}</span>
    </p>`;

  await t.sendMail({
    from: `"SOS Children's Villages Palestine" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: customSubject || `Review Required: ${doc.title}`,
    html: emailShell(body),
  });
}

// ── Password reset email ──────────────────────────────────────────────────────

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

  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#1a202c;">Reset your password</h1>
    <p style="margin:0 0 12px;font-size:15px;color:#4a5568;line-height:1.7;">Hi <strong>${esc(name)}</strong>,</p>
    <p style="margin:0 0 28px;font-size:15px;color:#4a5568;line-height:1.7;">
      We received a request to reset your WorkflowSign password. Click the button below to choose a new one.
      This link expires in <strong>1 hour</strong>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td align="center">
          <a href="${resetUrl}"
             style="display:inline-block;background:#1a3a5c;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:8px;letter-spacing:0.3px;">
            Reset Password &rarr;
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:13px;color:#8a95a3;text-align:center;line-height:1.6;">
      If you did not request a password reset, you can safely ignore this email — your password will not change.
    </p>`;

  await t.sendMail({
    from: `"SOS Children's Villages Palestine" <${process.env.SMTP_USER}>`,
    to: `${name} <${email}>`,
    subject: "Reset your WorkflowSign password",
    html: emailShell(body),
  });
}

// ── Sign-unlock email (after review approval) ────────────────────────────────

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

  const approvedByHtml = approvedByNames.length > 0
    ? `<p style="margin:0 0 24px;font-size:15px;color:#4a5568;line-height:1.7;">
        This document has been reviewed and approved by <strong>${esc(approvedByNames.join(", "))}</strong>. It is now ready for your signature.
       </p>`
    : `<p style="margin:0 0 24px;font-size:15px;color:#4a5568;line-height:1.7;">
        This document has been reviewed and approved. It is now ready for your signature.
       </p>`;

  const customMessageHtml = customMessage
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="background:#f0fdf4;border-left:4px solid #16a34a;border-radius:0 8px 8px 0;padding:14px 18px;">
            <p style="margin:0;font-size:14px;color:#166534;line-height:1.7;">${esc(customMessage)}</p>
          </td>
        </tr>
      </table>`
    : "";

  const body = `
    <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#16a34a;text-transform:uppercase;letter-spacing:0.07em;">&#10003; Review Approved</p>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a202c;line-height:1.3;">Ready to Sign</h1>
    <p style="margin:0 0 8px;font-size:15px;color:#4a5568;line-height:1.7;">
      Hi <strong>${esc(recipient.teamName)}</strong>,
    </p>
    ${approvedByHtml}
    ${customMessageHtml}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;background:#f7f9fb;border:1px solid #dde3ea;border-radius:8px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#8a95a3;">Document</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:#1a202c;">${esc(doc.title)}</p>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td align="center">
          <a href="${signUrl}"
             style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:8px;letter-spacing:0.3px;">
            Sign Document &rarr;
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:12px;color:#8a95a3;text-align:center;line-height:1.6;">
      Or copy this link into your browser:<br/>
      <span style="color:#16a34a;word-break:break-all;">${signUrl}</span>
    </p>`;

  await t.sendMail({
    from: `"SOS Children's Villages Palestine" <${process.env.SMTP_USER}>`,
    to: `${recipient.teamName} <${recipient.email}>`,
    subject: `Ready to Sign: ${doc.title}`,
    html: emailShell(body),
  });
}
