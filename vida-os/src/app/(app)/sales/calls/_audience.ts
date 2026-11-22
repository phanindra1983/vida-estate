import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { callableLeadWhere } from "@/lib/bolna";
import { LEAD_SOURCES, LEAD_STAGES } from "@/lib/constants";

/** Who a campaign calls, from the form on the Campaigns tab. */
export type Audience = { projectId: string; stages: string[]; sources: string[]; idleDays: number; limit: number };

export const MAX_CAMPAIGN = 200;

export function readAudience(get: (k: string) => string | string[] | undefined | null): Audience {
  const list = (v: string | string[] | undefined | null) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
  const stages = list(get("stage")).filter((s) => LEAD_STAGES.some((x) => x.key === s));
  return {
    projectId: String(get("projectId") ?? ""),
    stages: stages.length ? stages : ["NEW", "CONTACTED"],
    sources: list(get("source")).filter((s) => s in LEAD_SOURCES),
    idleDays: Math.max(0, Math.min(365, Number(get("idleDays") ?? 0) || 0)),
    limit: Math.max(1, Math.min(MAX_CAMPAIGN, Number(get("limit") ?? 50) || 50)),
  };
}

export function audienceWhere(a: Audience, u: CurrentUser): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [callableLeadWhere, { stage: { in: a.stages } }];
  if (a.projectId) and.push({ projectId: a.projectId });
  if (u.projectIds !== "ALL") and.push({ projectId: { in: u.projectIds } });
  if (a.sources.length) and.push({ source: { in: a.sources } });
  if (a.idleDays) {
    const before = new Date(Date.now() - a.idleDays * 864e5);
    and.push({ OR: [{ lastActivityAt: { lt: before } }, { lastActivityAt: null, createdAt: { lt: before } }] });
  }
  return { AND: and };
}

export async function describeAudience(a: Audience) {
  const p = a.projectId ? await db.project.findUnique({ where: { id: a.projectId }, select: { name: true } }) : null;
  return [
    p?.name ?? "All projects",
    a.stages.map((s) => LEAD_STAGES.find((x) => x.key === s)?.label ?? s).join(", "),
    a.sources.length ? a.sources.map((s) => LEAD_SOURCES[s] ?? s).join(", ") : "",
    a.idleDays ? `no activity ${a.idleDays}+ days` : "",
  ].filter(Boolean).join(" · ");
}
