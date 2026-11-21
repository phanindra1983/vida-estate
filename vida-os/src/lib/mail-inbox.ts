import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { put } from "@vercel/blob";
import { db } from "./db";
import { notifyRoles, esc } from "./telegram";
import { publicUrl } from "./notify";

/**
 * Supplier replies: reads the purchase mailbox (the same Gmail account that sends enquiries,
 * SMTP_USER + SMTP_PASS, over IMAP) and files each supplier email on its enquiry's trail.
 *
 * Read-only: the mailbox is opened read-only, nothing is marked read, moved or deleted.
 * Only mail that belongs to an enquiry is imported: the subject carries an RFQ number, or the
 * sender is a vendor invited to an open enquiry. Everything else in the inbox is never stored.
 */
export const inboxConfigured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);

const RFQ_NO = /RFQ-[A-Z0-9]+-\d{3,}/i;
const STALE_MS = 5 * 60_000;
const LOOKBACK_DAYS = 21;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const KEEP_TYPES = /^(application\/pdf|image\/|application\/vnd\.(openxmlformats|ms-excel)|text\/csv|application\/msword)/;

export type InboxResult = { checkedAt: string; filed: number; error?: string };
export type Attachment = { name: string; url: string; size: number };

/** Keep only what the supplier wrote now, not the quoted history below it. */
export function newPart(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((l) =>
    /^On .{6,200}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) ||
    /^From:\s.+/.test(l.trim()) && lines.slice(0, lines.indexOf(l)).some((x) => x.trim()) ||
    l.startsWith(">"));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return (kept || text.trim()).slice(0, 20_000);
}

async function setSetting(key: string, value: string) {
  await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export async function lastInboxCheck(): Promise<InboxResult | null> {
  const s = await db.setting.findUnique({ where: { key: "mail.inbox.last" } });
  try { return s ? (JSON.parse(s.value) as InboxResult) : null; } catch { return null; }
}

/** Check the mailbox at most every 5 minutes (called when procurement pages open). Never throws. */
export async function checkInboxIfStale(timeoutMs = 8000) {
  if (!inboxConfigured()) return null;
  const last = await lastInboxCheck();
  if (last && Date.now() - new Date(last.checkedAt).getTime() < STALE_MS) return last;
  return Promise.race([
    checkInbox(),
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]).catch(() => null);
}

/** Read the inbox and file new supplier mail. Returns how many emails were filed. */
export async function checkInbox(): Promise<InboxResult> {
  const checkedAt = new Date().toISOString();
  // Claim this run first, so two page loads don't read the mailbox twice.
  await setSetting("mail.inbox.last", JSON.stringify({ checkedAt, filed: 0 }));
  if (!inboxConfigured()) return { checkedAt, filed: 0, error: "Mailbox not connected" };

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com", port: Number(process.env.IMAP_PORT || 993), secure: true,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! }, logger: false,
  });
  let filed = 0;
  let error: string | undefined;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
      const uids = (await client.search({ since }, { uid: true })) || [];
      if (uids.length) {
        // Who might be writing about an enquiry: vendors invited to an enquiry in the last 90 days.
        const invites = await db.rfqInvite.findMany({
          where: { sentAt: { gt: new Date(Date.now() - 90 * 864e5) } },
          include: { rfq: { select: { id: true, number: true, status: true, createdAt: true } } },
          orderBy: { sentAt: "desc" },
        });
        const vendors = await db.vendor.findMany({ where: { id: { in: [...new Set(invites.map((i) => i.vendorId))] }, email: { not: null } }, select: { id: true, name: true, email: true } });
        const vendorByEmail = new Map(vendors.map((v) => [v.email!.trim().toLowerCase(), v]));
        const own = (process.env.SMTP_USER || "").toLowerCase();

        // Pass 1: envelopes only. Pick out the mail that belongs to an enquiry.
        const wanted: number[] = [];
        for await (const m of client.fetch(uids.slice(-500), { uid: true, envelope: true }, { uid: true })) {
          const from = m.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
          const subject = m.envelope?.subject ?? "";
          if (!from) continue;
          // Our own mail is skipped, except a reply to a test-mode email (it comes back from our own address).
          if (from === own && !(/^\s*re:/i.test(subject) && /\[TEST for /i.test(subject))) continue;
          if (RFQ_NO.test(subject) || vendorByEmail.has(from)) wanted.push(m.uid);
        }
        // Pass 2: the full message for those only.
        for (const uid of wanted) {
          const msg = await client.fetchOne(String(uid), { uid: true, source: true, envelope: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const mail = await simpleParser(msg.source);
          const messageId = mail.messageId || `uid-${uid}-${String(msg.envelope?.date ?? "")}`;
          if (await db.rfqMessage.findUnique({ where: { messageId } })) continue;

          const from = mail.from?.value?.[0]?.address?.toLowerCase() ?? "";
          const subject = mail.subject ?? "(no subject)";
          // Test mode sends "[TEST for vendor@x] ..."; a reply to it names the vendor in the subject.
          const testFor = subject.match(/\[TEST for ([^\]\s]+)\]/i)?.[1]?.toLowerCase();
          const vendor = vendorByEmail.get(from) ?? (testFor ? vendorByEmail.get(testFor) : undefined);

          let rfq: { id: string; number: string } | undefined;
          let matchedBy = "RFQ_NUMBER";
          const no = subject.match(RFQ_NO)?.[0]?.toUpperCase() ?? (mail.text ?? "").match(RFQ_NO)?.[0]?.toUpperCase();
          if (no) rfq = (await db.rfq.findUnique({ where: { number: no }, select: { id: true, number: true } })) ?? undefined;
          if (!rfq && vendor) {
            // No number: the vendor's most recent enquiry that is still open, else their latest one.
            const mine = invites.filter((i) => i.vendorId === vendor.id);
            const open = mine.find((i) => ["SENT", "READY", "IN_APPROVAL"].includes(i.rfq.status));
            const pick = open ?? mine[0];
            if (pick) { rfq = { id: pick.rfq.id, number: pick.rfq.number }; matchedBy = "SENDER"; }
          }
          if (!rfq) continue;

          const attachments: Attachment[] = [];
          for (const a of mail.attachments ?? []) {
            if (a.related || a.size > MAX_ATTACH_BYTES || !KEEP_TYPES.test(a.contentType)) continue;
            const name = (a.filename || "attachment").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
            if (process.env.BLOB_READ_WRITE_TOKEN) {
              const blob = await put(`rfq-mail/${rfq.number}/${Date.now()}-${name}`, a.content, { access: "public", contentType: a.contentType, addRandomSuffix: true });
              attachments.push({ name, url: blob.url, size: a.size });
            }
          }
          const body = newPart(mail.text || (mail.html ? String(mail.html).replace(/<[^>]+>/g, " ") : ""));
          try {
            await db.rfqMessage.create({
              data: {
                rfqId: rfq.id, vendorId: vendor?.id, messageId, fromAddr: mail.from?.text?.slice(0, 300) || from,
                subject: subject.slice(0, 500), body, attachments: JSON.stringify(attachments), matchedBy,
                receivedAt: mail.date ?? new Date(),
              },
            });
          } catch { continue; } // filed by a parallel run
          filed++;
          const who = vendor?.name ?? from;
          const files = attachments.length ? `\n📎 ${attachments.map((a) => esc(a.name)).join(", ")}` : "";
          const r = await db.rfq.findUnique({ where: { id: rfq.id }, select: { projectId: true } });
          await notifyRoles(["PURCHASE", "PROJECT_MANAGER", "GM_PROJECTS"],
            `📩 <b>${esc(who)}</b> replied on <b>${rfq.number}</b>\n${esc(body.slice(0, 300))}${body.length > 300 ? "…" : ""}${files}\n${publicUrl(`/procurement/rfq/${rfq.id}`)}`,
            { projectId: r?.projectId });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    error = (e as Error).message.slice(0, 200);
    try { client.close(); } catch {}
  }
  const result: InboxResult = { checkedAt, filed, ...(error ? { error } : {}) };
  await setSetting("mail.inbox.last", JSON.stringify(result));
  return result;
}
