import { db } from "./db";
import { canDecide } from "./approvals";
import { ALL_PROJECT_ROLES } from "./constants";
import { inr, num, istDay, istDayStart } from "./format";
import { send, esc, botConfigured } from "./telegram";
import { ON_SITE_METRES } from "./telegram-bot";

/**
 * Morning plan (8:00 IST) and evening summary (19:00 IST), sent on Telegram to
 * the MD, GM Projects and project managers, each for the projects they can see.
 * In the evening, site engineers who have not sent today's report get a reminder.
 */

const DIGEST_ROLES = ["MD", "GM_PROJECTS", "PROJECT_MANAGER"];
const MR_APPROVERS = ["PROJECT_MANAGER", "GM_PROJECTS"];
const LIMIT = 3900; // Telegram allows 4096 characters

type Reader = { id: string; name: string; role: string; chatId: string; projectIds: string[] | "ALL" };

async function readers(): Promise<Reader[]> {
  const users = await db.user.findMany({ where: { active: true, role: { in: DIGEST_ROLES }, telegramChatId: { not: null } }, include: { access: true } });
  return users.map((u) => ({ id: u.id, name: u.name, role: u.role, chatId: u.telegramChatId!, projectIds: ALL_PROJECT_ROLES.includes(u.role) ? "ALL" : u.access.map((a) => a.projectId) }));
}

const inScope = (r: Reader) => (r.projectIds === "ALL" ? {} : { id: { in: r.projectIds } });
const dayLabel = (offset = 0) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(istDayStart(offset));

async function waitingFor(r: Reader) {
  const pending = await db.approvalRequest.findMany({ where: { status: "PENDING" }, take: 200 });
  let n = 0;
  for (const a of pending) {
    if (r.projectIds !== "ALL" && a.projectId && !r.projectIds.includes(a.projectId)) continue;
    if ((await canDecide(r, a)).ok) n++;
  }
  if (MR_APPROVERS.includes(r.role)) {
    n += await db.materialRequest.count({ where: { status: "SUBMITTED", requestedById: { not: r.id }, ...(r.projectIds === "ALL" ? {} : { projectId: { in: r.projectIds } }) } });
  }
  return n;
}

/** Site engineers with access to the project who have not reported on that IST day. */
async function silentEngineers(projectId: string, from: Date, to: Date) {
  const engineers = await db.user.findMany({ where: { active: true, role: "SITE_ENGINEER", access: { some: { projectId } } } });
  const reported = new Set((await db.dailyReport.findMany({ where: { projectId, createdAt: { gte: from, lt: to } }, select: { engineerId: true } })).map((x) => x.engineerId));
  return engineers.filter((e) => !reported.has(e.id));
}

async function projectLines(projectId: string, kind: "morning" | "evening") {
  const now = new Date();
  const from = istDayStart(kind === "morning" ? -1 : 0), to = istDayStart(kind === "morning" ? 0 : 1);
  const lines: string[] = [];

  const reports = await db.dailyReport.findMany({ where: { projectId, createdAt: { gte: from, lt: to } } });
  const labour = reports.reduce((a, r) => a + r.labourCount, 0);
  const photos = reports.reduce((a, r) => a + (JSON.parse(r.photos || "[]") as unknown[]).length, 0);
  const silent = await silentEngineers(projectId, from, to);
  const when = kind === "morning" ? "Yesterday" : "Today";
  lines.push(reports.length ? `${when}: ${reports.length} report${reports.length > 1 ? "s" : ""}, ${num(labour)} labour, ${photos} photos` : `${when}: no daily report`);
  if (silent.length) lines.push(`No report from: ${silent.map((e) => esc(e.name)).join(", ")}`);

  const day = istDay(kind === "morning" ? -1 : 0);
  const att = await db.attendance.findMany({ where: { projectId, day } });
  if (att.length) {
    const off = att.filter((a) => a.inMeters != null && a.inMeters > ON_SITE_METRES).length;
    lines.push(`Checked in: ${att.length}${off ? ` (⚠️ ${off} off site)` : ""}`);
  }

  const overdue = await db.milestone.findMany({ where: { projectId, status: { not: "DONE" }, plannedEnd: { lt: now } }, orderBy: { plannedEnd: "asc" }, take: 3 });
  for (const m of overdue) lines.push(`⏰ ${esc(m.name)}: ${Math.ceil((now.getTime() - m.plannedEnd.getTime()) / 864e5)} days late, ${m.progressPct}% done`);

  if (kind === "morning") {
    const starting = await db.milestone.findMany({ where: { projectId, status: "NOT_STARTED", plannedStart: { gte: istDayStart(0), lt: istDayStart(7) } }, orderBy: { plannedStart: "asc" }, take: 3 });
    for (const m of starting) lines.push(`▶️ Starts ${dayLabelOf(m.plannedStart)}: ${esc(m.name)}`);
    const needed = await db.materialRequest.findMany({ where: { projectId, status: { in: ["SUBMITTED", "APPROVED"] }, neededBy: { lt: istDayStart(4) } }, orderBy: { neededBy: "asc" }, take: 3 });
    for (const r of needed) lines.push(`📦 ${num(r.qty)} ${esc(r.unit)} ${esc(r.item)} needed ${dayLabelOf(r.neededBy)}, not yet ordered`);
  } else {
    const mrs = await db.materialRequest.count({ where: { projectId, createdAt: { gte: from, lt: to } } });
    if (mrs) lines.push(`📦 ${mrs} material request${mrs > 1 ? "s" : ""} raised today`);
  }

  const newIssues = await db.siteIssue.findMany({ where: { projectId, createdAt: { gte: from, lt: to } } });
  const openIssues = await db.siteIssue.findMany({ where: { projectId, status: "OPEN" } });
  const openSafety = openIssues.filter((i) => i.kind === "SAFETY");
  if (newIssues.length) lines.push(`New ${kind === "morning" ? "yesterday" : "today"}: ${newIssues.filter((i) => i.kind === "SNAG").length} snags, ${newIssues.filter((i) => i.kind === "SAFETY").length} safety`);
  if (openIssues.length) lines.push(`Open: ${openIssues.length - openSafety.length} snags, ${openSafety.length} safety${openSafety.some((i) => i.severity === "HIGH") ? " (🚨 high)" : ""}`);
  return lines;
}

const dayLabelOf = (d: Date) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(d);

async function salesLines(kind: "morning" | "evening") {
  const from = istDayStart(kind === "morning" ? -1 : 0), to = istDayStart(kind === "morning" ? 0 : 1);
  const now = new Date();
  const [leads, bookings, receipts, followUps, overdue] = await Promise.all([
    db.lead.count({ where: { createdAt: { gte: from, lt: to } } }),
    db.booking.count({ where: { bookedAt: { gte: from, lt: to } } }),
    db.receipt.aggregate({ where: { receivedAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    db.lead.count({ where: { nextFollowUp: { lt: now }, stage: { notIn: ["BOOKED", "AGREEMENT_SIGNED", "LOST"] } } }),
    db.demand.aggregate({ where: { status: { not: "PAID" }, dueDate: { lt: now } }, _sum: { amount: true }, _count: true }),
  ]);
  const when = kind === "morning" ? "Yesterday" : "Today";
  const lines = [`${when}: ${leads} new leads, ${bookings} bookings, ${inr(receipts._sum.amount ?? 0)} collected`];
  if (followUps) lines.push(`📞 ${followUps} lead follow-ups overdue`);
  if (overdue._count) lines.push(`💰 ${overdue._count} payment demands overdue, ${inr(overdue._sum.amount ?? 0)}`);
  return lines;
}

function clip(text: string) {
  return text.length > LIMIT ? text.slice(0, LIMIT) + "\n…\nOpen Vida OS for the rest." : text;
}

async function digestText(r: Reader, kind: "morning" | "evening", cache = new Map<string, string[]>()) {
  const projects = await db.project.findMany({ where: { ...inScope(r), status: { not: "COMPLETED" } }, orderBy: { name: "asc" } });
  const parts = [kind === "morning" ? `☀️ <b>Good morning, ${esc(r.name.split(" ")[0])}</b> · ${dayLabel()}` : `🌙 <b>Today on site</b> · ${dayLabel()}`];
  for (const p of projects) {
    if (!cache.has(p.id)) cache.set(p.id, await projectLines(p.id, kind));
    parts.push(`\n<b>${esc(p.name)}</b>\n${cache.get(p.id)!.join("\n")}`);
  }
  if (r.role === "MD") parts.push(`\n<b>Sales &amp; collections</b>\n${(await salesLines(kind)).join("\n")}`);
  const waiting = await waitingFor(r);
  parts.push(waiting ? `\n✋ <b>${waiting} waiting for your approval.</b> Send /approvals.` : "\nNothing is waiting for your approval.");
  return clip(parts.join("\n"));
}

/** /summary in the bot: the morning plan before 2 pm IST, the day's summary after. */
export async function summaryFor(user: { id: string; name: string; role: string; projectIds: string[] | "ALL" }, chatId: string) {
  if (!DIGEST_ROLES.includes(user.role)) return send(chatId, "The summary is for the MD, GM Projects and project managers.");
  const hourIst = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
  return send(chatId, await digestText({ ...user, chatId }, hourIst < 14 ? "morning" : "evening"));
}

export async function sendDigest(kind: "morning" | "evening") {
  if (!botConfigured()) return { sent: 0, reminders: 0, note: "bot not set up" };
  let sent = 0, reminders = 0;
  const cache = new Map<string, string[]>();
  for (const r of await readers()) {
    try {
      await send(r.chatId, await digestText(r, kind, cache));
      sent++;
    } catch {
      // A blocked chat must not stop the others.
    }
  }

  if (kind === "evening") {
    const from = istDayStart(0), to = istDayStart(1);
    const engineers = await db.user.findMany({ where: { active: true, role: "SITE_ENGINEER", telegramChatId: { not: null } }, include: { access: { include: { project: true } } } });
    for (const e of engineers) {
      const reported = await db.dailyReport.findMany({ where: { engineerId: e.id, createdAt: { gte: from, lt: to } }, select: { projectId: true } });
      const done = new Set(reported.map((x) => x.projectId));
      const missing = e.access.filter((a) => a.project.status === "UNDER_CONSTRUCTION" && !done.has(a.projectId));
      if (!missing.length) continue;
      try {
        await send(e.telegramChatId!, `Reminder: today's site report for ${missing.map((a) => `<b>${esc(a.project.name)}</b>`).join(", ")} is not in yet. Send /report.`);
        reminders++;
      } catch {}
    }
  }
  // Site visits: reminders the evening before and the morning of, no-show checks, revisit nudges.
  const visits = await (await import("./visits")).runVisitReminders(kind).catch((e) => ({ error: (e as Error).message }));
  return { sent, reminders, visits };
}
