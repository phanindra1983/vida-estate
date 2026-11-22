"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject, type CurrentUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { SALES_ROLES, SALES_MANAGERS } from "@/lib/constants";
import { intakeLead } from "@/lib/sales";
import { qualifyLead } from "@/lib/qualify";
import { refreshScore } from "@/lib/lead-score";
import { bolnaConfigured, getConfig, launchCampaign, startCall } from "@/lib/bolna";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (f: FormData, fallback: string) => {
  const b = s(f, "back");
  return b.startsWith("/") ? b : fallback;
};
function go(path: string, key: "ok" | "error", msg: string): never {
  const [p, q] = path.split("?");
  const sp = new URLSearchParams(q);
  sp.delete("ok");
  sp.delete("error");
  sp.set(key, msg);
  redirect(`${p}?${sp.toString()}`);
}

/** "2026-11-24T10:30" typed in India → a Date. */
function istLocal(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(`${v}:00+05:30`);
  return isNaN(d.getTime()) ? null : d;
}

async function visibleLeads(u: CurrentUser, ids: string[]) {
  const leads = await db.lead.findMany({ where: { id: { in: ids } } });
  return leads.filter((l) => (u.role === "SALES_EXEC" ? l.ownerId === u.id : canSeeProject(u, l.projectId) || u.projectIds === "ALL"));
}

/** Pre-sales, CPs' handlers or anyone in sales: post a lead that is already qualified. */
export async function postQualifiedLead(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const path = back(f, "/sales/qualified");
  if (f.get("consent") !== "on") go(path, "error", "Tick the box to confirm the buyer agreed to be contacted.");
  const projectId = s(f, "projectId") || null;
  if (projectId && !canSeeProject(u, projectId)) go(path, "error", "You don't have access to that project.");
  let leadId = "", name = "";
  try {
    const res = await intakeLead(
      { name: s(f, "name"), phone: s(f, "phone"), email: s(f, "email") || null, projectId, source: s(f, "source") || "STAFF", notes: s(f, "note") || null, consentAt: new Date(), preferredType: s(f, "preferredType") || null },
      u,
    );
    leadId = res.lead.id;
    name = res.lead.name;
    if (!res.lead.consentAt) await db.lead.update({ where: { id: leadId }, data: { consentAt: new Date() } });
    await qualifyLead(leadId, u, { budget: s(f, "budget"), preferredType: s(f, "preferredType"), purpose: s(f, "purpose"), timeline: s(f, "timeline"), note: s(f, "note") || null });
    if (f.get("aiCall") === "on" && bolnaConfigured() && (await getConfig()).agentId) await startCall({ leadId, trigger: "MANUAL", userId: u.id });
  } catch (e) {
    go(path, "error", (e as Error).message);
  }
  revalidatePath("/sales");
  go(path, "ok", `${name} posted as a qualified lead. The salesperson has been alerted${f.get("aiCall") === "on" ? ", and the AI caller is ringing them" : ""}.`);
}

/** On a lead: record budget, size, purpose, timeline and mark it qualified. */
export async function markQualified(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const id = s(f, "leadId");
  const path = back(f, `/sales/leads/${id}`);
  const [lead] = await visibleLeads(u, [id]);
  if (!lead) go(path, "error", "Lead not found.");
  if (["LOST", "BOOKED", "AGREEMENT_SIGNED"].includes(lead.stage)) go(path, "error", "This lead is closed.");
  try {
    await qualifyLead(id, u, { budget: s(f, "budget"), preferredType: s(f, "preferredType"), purpose: s(f, "purpose"), timeline: s(f, "timeline"), note: s(f, "note") || null });
  } catch (e) {
    go(path, "error", (e as Error).message);
  }
  revalidatePath("/sales");
  go(path, "ok", lead.qualifiedAt ? "Qualification details updated." : "Marked qualified. It now shows on the Qualified leads tab.");
}

/** Remove from qualified (e.g. posted by mistake). Managers only. */
export async function unqualify(f: FormData) {
  const u = await requireUser(SALES_MANAGERS);
  const id = s(f, "leadId");
  const path = back(f, `/sales/leads/${id}`);
  const [lead] = await visibleLeads(u, [id]);
  if (!lead) go(path, "error", "Lead not found.");
  await db.lead.update({ where: { id }, data: { qualifiedAt: null, qualifiedById: null, stage: lead.stage === "QUALIFIED" ? "CONTACTED" : lead.stage } });
  await db.activity.create({ data: { leadId: id, userId: u.id, type: "STAGE", note: "No longer qualified" } });
  await audit(u, "UPDATE", "Lead", id, `${lead.name} un-qualified`);
  await refreshScore(id);
  revalidatePath("/sales");
  go(path, "ok", "Removed from qualified leads.");
}

/** Bulk actions on ticked leads: AI call now, schedule AI calls, or assign. */
export async function bulkLeads(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const path = back(f, "/sales/leads");
  const op = s(f, "op");
  const ids = [...new Set(f.getAll("ids").map(String))].slice(0, 200);
  if (!ids.length) go(path, "error", "Tick at least one lead first.");
  const leads = await visibleLeads(u, ids);

  if (op === "assign") {
    if (!SALES_MANAGERS.includes(u.role)) go(path, "error", "Only sales managers can assign leads.");
    const owner = await db.user.findUnique({ where: { id: s(f, "ownerId") } });
    if (!owner || !owner.active || !["SALES_EXEC", "SALES_MANAGER", "SALES_HEAD"].includes(owner.role)) go(path, "error", "Pick a salesperson to assign to.");
    await db.lead.updateMany({ where: { id: { in: leads.map((l) => l.id) } }, data: { ownerId: owner.id } });
    await db.activity.createMany({ data: leads.map((l) => ({ leadId: l.id, userId: u.id, type: "SYSTEM", note: `Assigned to ${owner.name}` })) });
    await audit(u, "UPDATE", "Lead", null, `Assigned ${leads.length} leads to ${owner.name}`);
    revalidatePath("/sales");
    go(path, "ok", `${leads.length} lead${leads.length === 1 ? "" : "s"} assigned to ${owner.name}.`);
  }

  if (op === "ai_now" || op === "ai_schedule") {
    if (!bolnaConfigured() || !(await getConfig()).agentId) go(path, "error", "The AI caller isn't set up yet (Sales → AI call centre).");
    const when = op === "ai_schedule" ? istLocal(s(f, "when")) : null;
    if (op === "ai_schedule" && (!when || when.getTime() < Date.now() + 60_000)) go(path, "error", "Pick a date and time in the future for the scheduled calls.");
    const callable = leads.filter((l) => l.consentAt && !l.doNotCallAt && !["LOST", "BOOKED", "AGREEMENT_SIGNED"].includes(l.stage));
    const skipped = leads.length - callable.length;
    if (!callable.length) go(path, "error", "None of the ticked leads can be called by the AI (no consent recorded, asked not to be called, or closed).");
    const label = when ? when.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const name = s(f, "campaignName") || `${s(f, "listName") || "Selected leads"} · ${label}`;
    const campaign = await db.aiCampaign.create({ data: { name, audience: `${callable.length} ticked leads${s(f, "listName") ? ` from ${s(f, "listName")}` : ""}`, total: callable.length, createdById: u.id, scheduledFor: when } });
    const placed = await launchCampaign(campaign.id, callable.map((l) => l.id), u.id, when ?? undefined);
    await audit(u, "CREATE", "AiCampaign", campaign.id, `${when ? `Scheduled for ${label}` : "Started"}: AI calls to ${placed} leads`);
    revalidatePath("/sales");
    const mins = Math.ceil((placed * 30) / 60);
    go(path, "ok", `${placed} AI call${placed === 1 ? "" : "s"} ${when ? `scheduled from ${label}` : "starting now"}, about 2 a minute (≈${mins} min in all, only 9 am–9 pm).${skipped ? ` ${skipped} skipped: no consent, asked not to call, or closed.` : ""} Follow progress in AI call centre → Campaigns.`);
  }

  go(path, "error", "Pick what to do with the ticked leads.");
}
