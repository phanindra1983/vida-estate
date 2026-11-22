"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { SALES_ROLES } from "@/lib/constants";
import { intakeLead } from "@/lib/sales";
import { createAgent, getConfig, saveConfig, startCall, saveCallerSettings, stopQueuedCalls, launchCampaign, LANGUAGES, VOICES, type CallerSettings } from "@/lib/bolna";
import { CALL_ROLES, CALL_MANAGERS, SETTINGS_ROLES } from "./_shared";
import { readAudience, audienceWhere, describeAudience, MAX_CAMPAIGN } from "./_audience";

const PAGE = "/sales/calls";
const go = (path: string, key: "ok" | "error", msg: string): never => redirect(`${path.split("?")[0]}?${key}=${encodeURIComponent(msg)}`);
const back = (fd: FormData, fallback: string) => {
  const b = String(fd.get("back") ?? "");
  return b.startsWith("/") ? b.split("?")[0] : fallback;
};
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** MD: create the calling agent on Bolna (or re-create it). */
export async function setupAgent() {
  const u = await requireUser(["MD"]);
  let id: string;
  try {
    id = await createAgent();
  } catch (e) {
    go(PAGE, "error", (e as Error).message);
  }
  await audit(u, "CREATE", "Setting", "bolna.config", `Set up the AI caller on Bolna (agent ${id!})`);
  revalidatePath(PAGE);
  go(PAGE, "ok", "AI caller is set up. Make a test call to your own number next.");
}

/** MD: switch automatic calling of new leads on or off. */
export async function setAutoCall(fd: FormData) {
  const u = await requireUser(["MD"]);
  const on = fd.get("on") === "1";
  const cfg = await getConfig();
  if (on && !cfg.agentId) go(PAGE, "error", "Set up the AI caller first.");
  await saveConfig({ ...cfg, autoCall: on });
  await audit(u, "UPDATE", "Setting", "bolna.config", on ? "Switched ON automatic AI calls to new leads" : "Switched OFF automatic AI calls to new leads", { before: { autoCall: cfg.autoCall }, after: { autoCall: on } });
  revalidatePath(PAGE);
  go(PAGE, "ok", on ? "New leads will now get an AI call within a minute (9 am to 9 pm)." : "Automatic AI calls are off.");
}

/** MD or sales head: a test call to their own phone. */
export async function testCall(fd: FormData) {
  const u = await requireUser(SETTINGS_ROLES);
  const to = s(fd, "phone");
  try {
    await startCall({ toNumber: to, trigger: "TEST", userId: u.id });
  } catch (e) {
    go(back(fd, PAGE), "error", (e as Error).message);
  }
  await audit(u, "CREATE", "AiCall", null, `Test AI call to ${to.slice(0, -4).replace(/\d/g, "•")}${to.slice(-4)}`);
  revalidatePath(PAGE);
  go(back(fd, PAGE), "ok", "Calling now. Answer your phone. The result appears in Call history in a minute or two.");
}

/** Anyone in sales who can see the lead: ask the AI caller to call this buyer now. */
export async function callLeadWithAi(fd: FormData) {
  const u = await requireUser(SALES_ROLES);
  const leadId = s(fd, "leadId");
  const path = back(fd, `/sales/leads/${leadId}`);
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead || (u.role === "SALES_EXEC" ? lead.ownerId !== u.id : !canSeeProject(u, lead.projectId))) go(path, "error", "Lead not found.");
  if (!lead!.consentAt) go(path, "error", "This buyer hasn't given consent to be contacted, so the AI caller won't call. Call them yourself.");
  try {
    await startCall({ leadId, trigger: "MANUAL", userId: u.id });
  } catch (e) {
    go(path, "error", (e as Error).message);
  }
  await audit(u, "CREATE", "AiCall", leadId, `Asked the AI caller to call ${lead!.name}`);
  revalidatePath(path);
  go(path, "ok", "The AI caller is calling now. The result will appear on this lead.");
}

/** Anyone in sales: type a name and number, the AI calls. The buyer is saved as a lead first. */
export async function callAnyNumber(fd: FormData) {
  const u = await requireUser(CALL_ROLES);
  if (fd.get("consent") !== "on") go(PAGE, "error", "Tick the box to confirm this person asked to be contacted. The AI only calls people who agreed.");
  const projectId = s(fd, "projectId") || null;
  if (projectId && !canSeeProject(u, projectId)) go(PAGE, "error", "You don't have access to that project.");
  let leadId: string;
  let name: string;
  try {
    const res = await intakeLead({ name: s(fd, "name"), phone: s(fd, "phone"), projectId, source: "STAFF", notes: s(fd, "note") || null, consentAt: new Date() }, u);
    leadId = res.lead.id;
    name = res.lead.name;
    if (!res.lead.consentAt) await db.lead.update({ where: { id: leadId }, data: { consentAt: new Date() } });
    // A salesperson adding their own contact keeps it.
    if (!res.duplicate && u.role === "SALES_EXEC" && res.lead.ownerId !== u.id) await db.lead.update({ where: { id: leadId }, data: { ownerId: u.id } });
    await startCall({ leadId, trigger: "MANUAL", userId: u.id });
  } catch (e) {
    go(PAGE, "error", (e as Error).message);
  }
  await audit(u, "CREATE", "AiCall", leadId!, `Asked the AI caller to call ${name!}`);
  revalidatePath(PAGE);
  go(PAGE, "ok", `The AI caller is ringing ${name!.split(" ")[0]} now (calls go out 9 am to 9 pm). The result appears in Call history and on the lead.`);
}

/** MD or sales head: what the AI caller says, its voice and language. Pushed to Bolna. */
export async function saveSettings(fd: FormData) {
  const u = await requireUser(SETTINGS_ROLES);
  const path = "/sales/calls/settings";
  const language = s(fd, "language");
  const voiceId = s(fd, "voiceId");
  const next: CallerSettings = {
    callerName: s(fd, "callerName").slice(0, 30) || "Priya",
    language: (language in LANGUAGES ? language : "en") as CallerSettings["language"],
    voiceId: VOICES.some((v) => v.id === voiceId) ? voiceId : "priya",
    welcome: s(fd, "welcome").slice(0, 400),
    notes: s(fd, "notes").slice(0, 3000),
    maxMinutes: Math.max(1, Math.min(10, Number(s(fd, "maxMinutes")) || 4)),
  };
  const before = (await getConfig()).settings;
  try {
    await saveCallerSettings(next);
  } catch (e) {
    go(path, "error", (e as Error).message);
  }
  await audit(u, "UPDATE", "Setting", "bolna.config", "Changed the AI caller's script, voice or language", { before, after: next });
  revalidatePath(path);
  go(path, "ok", "Saved. The next call uses the new settings. Make a test call to hear it.");
}

/** Managers: call a filtered list of leads, or a pasted list of names and numbers. */
export async function startCampaign(fd: FormData) {
  const u = await requireUser(CALL_MANAGERS);
  const path = "/sales/calls/campaigns";
  const cfg = await getConfig();
  if (!cfg.agentId) go(path, "error", "Set up the AI caller first.");
  const name = s(fd, "name").slice(0, 80) || `Campaign ${new Date().toLocaleDateString("en-IN")}`;
  let leadIds: string[] = [];
  let audience = "";

  if (s(fd, "mode") === "list") {
    if (fd.get("consent") !== "on") go(path, "error", "Tick the box to confirm everyone on the list asked to be contacted.");
    const projectId = s(fd, "projectId") || null;
    if (projectId && !canSeeProject(u, projectId)) go(path, "error", "You don't have access to that project.");
    const lines = s(fd, "list").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_CAMPAIGN);
    const bad: string[] = [];
    for (const line of lines) {
      const m = line.replace(/(\d)[\s-]+(?=\d)/g, "$1").match(/(?:\+?91)?([6-9]\d{9})/);
      const nm = line.replace(/[+\d][\d\s-]{8,}\d/, " ").replace(/[,;\t|]+/g, " ").replace(/\s+/g, " ").trim();
      if (!m || nm.length < 2) { bad.push(line); continue; }
      try {
        const res = await intakeLead({ name: nm, phone: m[1], projectId, source: "STAFF", campaign: name, consentAt: new Date() }, u);
        if (!res.lead.consentAt) await db.lead.update({ where: { id: res.lead.id }, data: { consentAt: new Date() } });
        if (!res.lead.doNotCallAt) leadIds.push(res.lead.id);
      } catch { bad.push(line); }
    }
    if (!leadIds.length) go(path, "error", bad.length ? `No valid lines. Use one buyer per line: name and 10-digit mobile. First problem: "${bad[0].slice(0, 60)}"` : "Paste at least one name and number.");
    audience = `Pasted list of ${lines.length}${bad.length ? ` (${bad.length} skipped)` : ""}`;
  } else {
    const a = readAudience((k) => (k === "stage" || k === "source" ? fd.getAll(k).map(String) : (fd.get(k) as string | null)));
    leadIds = (await db.lead.findMany({ where: audienceWhere(a, u), select: { id: true }, orderBy: { createdAt: "desc" }, take: a.limit })).map((l) => l.id);
    if (!leadIds.length) go(path, "error", "No buyers match those choices.");
    audience = await describeAudience(a);
  }

  const ids = [...new Set(leadIds)];
  const sa = s(fd, "startAt");
  const startAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sa) ? new Date(`${sa}:00+05:30`) : null;
  if (startAt && startAt.getTime() < Date.now() - 60_000) go(path, "error", "The start time is in the past.");
  const campaign = await db.aiCampaign.create({ data: { name, audience, total: ids.length, createdById: u.id, scheduledFor: startAt } });
  const placed = await launchCampaign(campaign.id, ids, u.id, startAt ?? undefined);
  await audit(u, "CREATE", "AiCampaign", campaign.id, `Started AI call campaign "${name}" to ${placed} buyers (${audience})`);
  revalidatePath(path);
  go(path, "ok", `Campaign ${startAt ? `scheduled from ${startAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "started"}: ${placed} calls queued, about 2 a minute, only between 9 am and 9 pm.`);
}

/** Managers: stop a running campaign (cancels every call still waiting in Bolna's queue). */
export async function stopCampaign(fd: FormData) {
  const u = await requireUser(CALL_MANAGERS);
  const path = "/sales/calls/campaigns";
  const id = s(fd, "id");
  const c = await db.aiCampaign.findUnique({ where: { id } });
  if (!c) go(path, "error", "Campaign not found.");
  let stopped = 0;
  try {
    stopped = await stopQueuedCalls();
  } catch (e) {
    go(path, "error", (e as Error).message);
  }
  await db.aiCampaign.update({ where: { id }, data: { status: "STOPPED" } });
  await audit(u, "UPDATE", "AiCampaign", id, `Stopped AI call campaign "${c!.name}" (${stopped} queued calls cancelled)`);
  revalidatePath(path);
  go(path, "ok", `Stopped. ${stopped} calls that hadn't started yet were cancelled.`);
}
