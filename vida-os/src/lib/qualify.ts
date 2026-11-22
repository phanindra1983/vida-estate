import { db } from "./db";
import { audit } from "./audit";
import { send, esc, notifyRoles } from "./telegram";
import { publicUrl } from "./notify";
import { refreshScore } from "./lead-score";
import { PURPOSES, TIMELINES } from "./constants";

/**
 * Pre-sales → sales handoff. A lead is "qualified" when the buyer is genuine and we know enough
 * to sell: budget, home size, purpose and timeline (as far as they said). Done by a person
 * (posting a qualified lead, or "Mark qualified" on the lead) or by the AI caller when the buyer
 * is interested. The lead's owner is alerted to call now.
 */
export type QualifyInput = { budget?: string | null; preferredType?: string | null; purpose?: string | null; timeline?: string | null; note?: string | null };

export async function qualifyLead(leadId: string, by: { id: string; name: string } | null, q: QualifyInput) {
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { project: true } });
  if (!lead) throw new Error("Lead not found.");
  const data = {
    qualifiedAt: lead.qualifiedAt ?? new Date(),
    qualifiedById: lead.qualifiedAt ? lead.qualifiedById : by?.id ?? null,
    budget: q.budget?.trim() || lead.budget,
    preferredType: q.preferredType?.trim() || lead.preferredType,
    purpose: q.purpose && q.purpose in PURPOSES ? q.purpose : lead.purpose,
    timeline: q.timeline && q.timeline in TIMELINES ? q.timeline : lead.timeline,
    stage: ["NEW", "CONTACTED"].includes(lead.stage) ? "QUALIFIED" : lead.stage,
    lastActivityAt: new Date(),
  };
  const facts = [
    data.preferredType && `Wants ${data.preferredType}`,
    data.budget && `Budget ${data.budget}`,
    data.purpose && PURPOSES[data.purpose],
    data.timeline && TIMELINES[data.timeline],
  ].filter(Boolean).join(" · ");
  await db.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: leadId }, data });
    await tx.activity.create({ data: { leadId, userId: by?.id ?? null, type: "STAGE", note: `Qualified${by ? "" : " by the AI caller"}${facts ? `: ${facts}` : ""}${q.note ? `\n${q.note}` : ""}` } });
    await audit(by, "UPDATE", "Lead", leadId, `${lead.name} marked qualified${by ? "" : " (AI caller)"}`, { before: { stage: lead.stage }, after: { ...data, qualifiedAt: undefined, lastActivityAt: undefined } }, tx);
  });
  await refreshScore(leadId);
  if (!lead.qualifiedAt) await alertOwner(leadId, by?.name ?? "AI caller", facts);
}

async function alertOwner(leadId: string, byName: string, facts: string) {
  try {
    const lead = await db.lead.findUnique({ where: { id: leadId }, include: { project: true } });
    if (!lead) return;
    const text = `⭐ <b>Qualified lead</b> · ${esc(lead.name)} · ${lead.phone}${lead.project ? `\n${esc(lead.project.name)}` : ""}${facts ? `\n${esc(facts)}` : ""}\nQualified by ${esc(byName)}. Please call now and fix the site visit.\n${publicUrl(`/sales/leads/${lead.id}`)}`;
    const owner = lead.ownerId ? await db.user.findUnique({ where: { id: lead.ownerId } }) : null;
    if (owner?.telegramChatId) await send(owner.telegramChatId, text);
    else await notifyRoles(["SALES_HEAD", "SALES_MANAGER"], `${text}\n<i>Nobody is assigned yet.</i>`, { projectId: lead.projectId });
  } catch {}
}

/** Best guess from what the buyer told the AI caller. */
export function purposeFrom(text?: string | null) {
  if (!text) return null;
  if (/invest|rent|return|appreciat/i.test(text)) return "INVEST";
  if (/live|stay|own use|self|family|end.?use|residen/i.test(text)) return "LIVE";
  return null;
}
export function timelineFrom(text?: string | null) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/immediate|now|this month|asap|ready/.test(t)) return "NOW";
  if (/(1|2|3|one|two|three)\s*month|next month|quarter/.test(t)) return "3M";
  if (/(4|5|6|four|five|six)\s*month|half/.test(t)) return "6M";
  if (/year|12 month|next year/.test(t)) return "12M";
  if (/later|not sure|explor|just looking/.test(t)) return "LATER";
  return null;
}
