import nodemailer from "nodemailer";
import { db } from "./db";

/**
 * Outgoing messages. Email goes out for real when a sender is configured in .env:
 *  - SMTP (Google Workspace, Gmail or any mail server): SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
 *  - or Resend: RESEND_API_KEY, MAIL_FROM
 * Otherwise it is queued in the outbox so the team can see exactly what would have gone.
 * MAIL_TEST_TO (test mode): every email goes to that address instead of the real recipient,
 * with the intended recipient shown at the top. Remove it to send to vendors for real.
 * WhatsApp is queued with a one-click wa.me link until a WhatsApp Business API account is connected.
 */
export function emailMode(): "SMTP" | "RESEND" | "OFF" {
  const e = process.env;
  if (e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS && e.MAIL_FROM) return "SMTP";
  if (e.RESEND_API_KEY && e.MAIL_FROM) return "RESEND";
  return "OFF";
}
export const emailTestTo = () => process.env.MAIL_TEST_TO || null;

let transport: nodemailer.Transporter | null = null;
function smtp() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

export async function sendEmail(to: string, subject: string, body: string, ref?: { type: string; id: string }, opts: { live?: boolean } = {}) {
  const mode = emailMode();
  const from = process.env.MAIL_FROM!;
  // A live enquiry goes to the real recipient even while test mode is on.
  const testTo = opts.live ? null : emailTestTo();
  const realTo = testTo || to;
  const realSubject = testTo ? `[TEST for ${to}] ${subject}` : subject;
  const realBody = testTo ? `TEST MODE: this email was meant for ${to}.\n\n${body}` : body;
  let status = "QUEUED";
  let error: string | null = mode === "OFF" ? "No email sender configured yet" : null;
  try {
    if (mode === "SMTP") {
      await smtp().sendMail({ from, to: realTo, subject: realSubject, text: realBody, replyTo: process.env.MAIL_REPLY_TO || undefined });
      status = "SENT";
    } else if (mode === "RESEND") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: realTo, subject: realSubject, text: realBody }),
      });
      status = res.ok ? "SENT" : "FAILED";
      if (!res.ok) error = `Email provider answered ${res.status}`;
    }
  } catch (e) {
    status = "FAILED";
    error = (e as Error).message.slice(0, 300);
  }
  if (status === "SENT" && testTo) error = `Test mode: delivered to ${testTo}`;
  return db.outboxMessage.create({ data: { channel: "EMAIL", to, subject, body, status, error, refType: ref?.type, refId: ref?.id } });
}

export async function queueWhatsApp(phone: string, body: string, ref?: { type: string; id: string }) {
  return db.outboxMessage.create({
    data: { channel: "WHATSAPP", to: phone, body, status: "QUEUED", error: "Send with one click until WhatsApp Business is connected", refType: ref?.type, refId: ref?.id },
  });
}

export function waLink(phone: string, text: string) {
  const d = phone.replace(/\D/g, "");
  const intl = d.length === 10 ? "91" + d : d;
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

export function publicUrl(path: string) {
  return (process.env.PUBLIC_OS_URL || "http://localhost:3100").replace(/\/$/, "") + path;
}
