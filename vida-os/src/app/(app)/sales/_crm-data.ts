import { db } from "@/lib/db";
import type { CrmLead } from "./_crm";

/** Attach each lead's latest AI call result (for the "AI: Interested" badge). */
export async function withLastAi<T extends { id: string }>(leads: T[]): Promise<(T & { lastAi: CrmLead["lastAi"] })[]> {
  if (!leads.length) return [];
  const calls = await db.aiCall.findMany({
    where: { leadId: { in: leads.map((l) => l.id) }, trigger: { not: "TEST" } },
    orderBy: { createdAt: "desc" },
    select: { leadId: true, interest: true, status: true },
  });
  const last = new Map<string, { interest: string | null; status: string }>();
  for (const c of calls) if (c.leadId && !last.has(c.leadId)) last.set(c.leadId, { interest: c.interest, status: c.status });
  return leads.map((l) => ({ ...l, lastAi: last.get(l.id) ?? null }));
}

export async function salesPeople() {
  return db.user.findMany({ where: { role: { in: ["SALES_EXEC", "SALES_MANAGER", "SALES_HEAD"] }, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
}

export async function userNames() {
  return new Map((await db.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}
