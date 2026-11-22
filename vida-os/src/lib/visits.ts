import { db } from "./db";
import { send, esc, notifyRoles, type Button } from "./telegram";
import { sendEmail, waLink, publicUrl } from "./notify";
import { istDayStart } from "./format";
import { refreshScore } from "./lead-score";

/**
 * Site-visit follow-through, the way the best Indian developer CRMs do it:
 * - 7 pm the evening before: the salesperson gets tomorrow's visits, each with a one-tap
 *   WhatsApp reminder to send the buyer (and the buyer gets an email if we have one).
 * - 8 am on the day: today's visits, with a "see you today" WhatsApp and the map link.
 * - 7 pm on the day: "Did they come?" with ✅ Came / ❌ No-show buttons for visits not yet marked.
 * - 8 am daily: buyers who visited but have gone quiet for 10+ days → a nudge to invite them back.
 * Runs from the morning and evening digest crons; each run happens at most once a day.
 */

export type Visit = {
  leadId: string; at: Date; note: string | null;
  lead: { id: string; name: string; phone: string; email: string | null; ownerId: string | null; projectId: string | null; stage: string; project: { name: string; location: string | null } | null };
};

const timeIST = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const dayIST = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "short" });
export const mapLink = (p: { name: string; location: string | null } | null) => `https://maps.google.com/?q=${encodeURIComponent(`${p?.name ?? "Vida Estates"} ${p?.location ?? "Hyderabad"}`)}`;

/** Visits still to happen (lead in "Site visit scheduled"), latest booking per lead, in [from, to). */
export async function visitsBetween(from: Date, to: Date, where: { ownerId?: string; projectIds?: string[] } = {}): Promise<Visit[]> {
  const rows = await db.activity.findMany({
    where: {
      type: "SITE_VISIT", scheduledFor: { gte: from, lt: to },
      lead: { stage: "VISIT_SCHEDULED", ...(where.ownerId ? { ownerId: where.ownerId } : {}), ...(where.projectIds ? { projectId: { in: where.projectIds } } : {}) },
    },
    orderBy: [{ createdAt: "desc" }],
    include: { lead: { select: { id: true, name: true, phone: true, email: true, ownerId: true, projectId: true, stage: true, project: { select: { name: true, location: true } } } } },
  });
  const latest = new Map<string, Visit>();
  for (const r of rows) if (!latest.has(r.leadId)) latest.set(r.leadId, { leadId: r.leadId, at: r.scheduledFor!, note: r.note, lead: r.lead });
  // A visit moved to another day must not show on the old day.
  const later = await db.activity.findMany({ where: { type: "SITE_VISIT", leadId: { in: [...latest.keys()] }, scheduledFor: { gte: to } }, select: { leadId: true, createdAt: true } });
  for (const l of later) {
    const v = latest.get(l.leadId);
    const booked = rows.find((r) => r.leadId === l.leadId)?.createdAt;
    if (v && booked && l.createdAt > booked) latest.delete(l.leadId);
  }
  return [...latest.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function reminderText(v: Visit, kind: "tomorrow" | "today" | "revisit", salesperson?: string | null) {
  const first = v.lead.name.split(" ")[0];
  const project = v.lead.project?.name ?? "Vida Estates";
  const me = salesperson ?? "the Vida Estates team";
  if (kind === "tomorrow") return `Hello ${first} ji, this is ${me} from Vida Estates. A gentle reminder of your site visit to ${project} tomorrow, ${dayIST(v.at)}, at ${timeIST(v.at)}. Location: ${mapLink(v.lead.project)}. Please let me know if the time needs to change. Looking forward to meeting you.`;
  if (kind === "today") return `Good morning ${first} ji, looking forward to welcoming you at ${project} today at ${timeIST(v.at)}. Location: ${mapLink(v.lead.project)}. Please call me when you are on the way. ${me}, Vida Estates`;
  return `Hello ${first} ji, thank you again for visiting ${project}. We would be happy to welcome you again, perhaps with your family, to see the show flat and the progress on site. Shall I book a time for you this week? ${me}, Vida Estates`;
}

async function onceToday(kind: string) {
  const key = `visits.reminded.${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}.${kind}`;
  const hit = await db.setting.findUnique({ where: { key } });
  if (hit) return false;
  await db.setting.create({ data: { key, value: new Date().toISOString() } }).catch(() => null);
  return true;
}

async function chatOf(userId: string | null) {
  if (!userId) return null;
  const u = await db.user.findUnique({ where: { id: userId }, select: { telegramChatId: true, name: true, active: true } });
  return u?.active ? u : null;
}

/** Send to the lead's owner; if nobody is linked, to the sales managers of the project. */
async function tellOwner(v: Visit, text: string, buttons: Button[][]) {
  const owner = await chatOf(v.lead.ownerId);
  if (owner?.telegramChatId) return send(owner.telegramChatId, text, buttons);
  return notifyRoles(["SALES_HEAD", "SALES_MANAGER"], `${text}\n<i>No salesperson linked on Telegram for this buyer.</i>`, { projectId: v.lead.projectId });
}

export async function runVisitReminders(kind: "morning" | "evening") {
  const out = { reminders: 0, emails: 0, checks: 0, revisits: 0 };
  if (!(await onceToday(kind))) return { ...out, skipped: "already ran today" };

  if (kind === "evening") {
    // Tomorrow's visits: remind the salesperson, with a ready WhatsApp for the buyer.
    for (const v of await visitsBetween(istDayStart(1), istDayStart(2))) {
      const owner = await chatOf(v.lead.ownerId);
      const wa = waLink(v.lead.phone, reminderText(v, "tomorrow", owner?.name));
      await tellOwner(v, `🗓 <b>Site visit tomorrow</b> · ${timeIST(v.at)}\n${esc(v.lead.name)} · ${v.lead.phone}\n${esc(v.lead.project?.name ?? "")}${v.note && v.note !== "Site visit scheduled" ? `\n${esc(v.note)}` : ""}\nSend the buyer a reminder now:`, [
        [{ text: "💬 Send WhatsApp reminder", url: wa }],
        [{ text: "Open in Vida OS", url: publicUrl(`/sales/leads/${v.leadId}`) }],
      ]).then(() => out.reminders++).catch(() => {});
      if (v.lead.email) {
        await sendEmail(v.lead.email, `Your site visit to ${v.lead.project?.name ?? "Vida Estates"} tomorrow at ${timeIST(v.at)}`, reminderText(v, "tomorrow", owner?.name), { type: "Lead", id: v.leadId })
          .then(() => out.emails++).catch(() => {});
      }
    }
    // Today's visits that should have happened: did they come?
    const now = new Date();
    for (const v of (await visitsBetween(istDayStart(0), istDayStart(1))).filter((x) => x.at < now)) {
      await tellOwner(v, `❓ <b>Did ${esc(v.lead.name)} come for the site visit?</b>\n${esc(v.lead.project?.name ?? "")} · today ${timeIST(v.at)}`, [
        [{ text: "✅ Came", data: `vd:${v.leadId}` }, { text: "❌ Didn't come", data: `vn:${v.leadId}` }],
      ]).then(() => out.checks++).catch(() => {});
    }
  }

  if (kind === "morning") {
    for (const v of await visitsBetween(istDayStart(0), istDayStart(1))) {
      const owner = await chatOf(v.lead.ownerId);
      await tellOwner(v, `📍 <b>Site visit today</b> · ${timeIST(v.at)}\n${esc(v.lead.name)} · ${v.lead.phone}\n${esc(v.lead.project?.name ?? "")}`, [
        [{ text: "💬 Send “see you today”", url: waLink(v.lead.phone, reminderText(v, "today", owner?.name)) }],
        [{ text: "✅ Came", data: `vd:${v.leadId}` }, { text: "❌ Didn't come", data: `vn:${v.leadId}` }],
      ]).then(() => out.reminders++).catch(() => {});
    }
    // Visited, then silence for 10+ days: invite them back (once every 10 days per buyer).
    const quiet = await db.lead.findMany({
      where: { stage: "VISIT_DONE", lastActivityAt: { lt: new Date(Date.now() - 10 * 864e5) }, doNotCallAt: null },
      include: { project: { select: { name: true, location: true } } }, take: 50,
    });
    for (const l of quiet) {
      const nudged = await db.activity.findFirst({ where: { leadId: l.id, type: "SYSTEM", note: { startsWith: "Revisit reminder" }, createdAt: { gt: new Date(Date.now() - 10 * 864e5) } } });
      if (nudged) continue;
      const owner = await chatOf(l.ownerId);
      const v: Visit = { leadId: l.id, at: new Date(), note: null, lead: { ...l } };
      await tellOwner(v, `🔁 <b>Invite back</b> · ${esc(l.name)} visited ${esc(l.project?.name ?? "")} and has been quiet for ${Math.floor((Date.now() - (l.lastActivityAt ?? l.createdAt).getTime()) / 864e5)} days.`, [
        [{ text: "💬 Send a revisit invite", url: waLink(l.phone, reminderText(v, "revisit", owner?.name)) }],
        [{ text: "Open in Vida OS", url: publicUrl(`/sales/leads/${l.id}`) }],
      ]).then(() => out.revisits++).catch(() => {});
      await db.activity.create({ data: { leadId: l.id, type: "SYSTEM", note: "Revisit reminder sent to the salesperson" } });
    }
  }
  return out;
}

/** ✅ Came / ❌ Didn't come, from Telegram or the Site visits page. */
export async function markVisit(leadId: string, came: boolean, by: { id: string; name: string } | null) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error("Lead not found.");
  if (lead.stage !== "VISIT_SCHEDULED") return { lead, changed: false };
  const tomorrowNoon = new Date(istDayStart(1).getTime() + 6.5 * 3600e3);
  await db.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: leadId },
      data: came
        ? { stage: "VISIT_DONE", lastActivityAt: new Date(), nextFollowUp: new Date(Date.now() + 2 * 864e5) }
        : { stage: lead.qualifiedAt ? "QUALIFIED" : "CONTACTED", lastActivityAt: new Date(), nextFollowUp: tomorrowNoon },
    });
    await tx.activity.create({ data: { leadId, userId: by?.id ?? null, type: "STAGE", note: came ? "Site visit done" : "Didn't come for the site visit (no-show). Call to fix a new time." } });
  });
  await refreshScore(leadId);
  return { lead, changed: true };
}
