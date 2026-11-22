"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { SALES_ROLES } from "@/lib/constants";
import { createAgent, getConfig, saveConfig, startCall } from "@/lib/bolna";

const PAGE = "/sales/calls";
const go = (path: string, key: "ok" | "error", msg: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(msg)}`);
const back = (fd: FormData, fallback: string) => {
  const b = String(fd.get("back") ?? "");
  return b.startsWith("/") ? b.split("?")[0] : fallback;
};

/** MD: create the calling agent on Bolna (or re-create it after changing the script). */
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
  const u = await requireUser(["MD", "SALES_HEAD"]);
  const to = String(fd.get("phone") ?? "");
  try {
    await startCall({ toNumber: to, trigger: "TEST", userId: u.id });
  } catch (e) {
    go(PAGE, "error", (e as Error).message);
  }
  await audit(u, "CREATE", "AiCall", null, `Test AI call to ${to.replace(/\d(?=\d{4})/g, "•")}`);
  revalidatePath(PAGE);
  go(PAGE, "ok", "Calling now. Answer your phone. The result appears below in a minute or two.");
}

/** Anyone in sales who can see the lead: ask the AI caller to call this buyer now. */
export async function callLeadWithAi(fd: FormData) {
  const u = await requireUser(SALES_ROLES);
  const leadId = String(fd.get("leadId") ?? "");
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
