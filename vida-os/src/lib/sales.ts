import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { normPhone } from "./format";
import { ESCALATION, LEAD_SOURCES } from "./constants";
import { projectScope, type CurrentUser } from "./auth";

export type IntakeInput = {
  name: string;
  phone: string;
  email?: string | null;
  projectId?: string | null;
  source: string;
  campaign?: string | null;
  channelPartnerId?: string | null;
  preferredType?: string | null;
  budget?: string | null;
  purpose?: string | null; // LIVE | INVEST
  timeline?: string | null; // NOW | 3M | 6M | 12M | LATER
  notes?: string | null;
  consentAt?: Date | null;
};

type Actor = Pick<CurrentUser, "id" | "name"> | null;

/**
 * One way in for every lead, whatever the channel.
 * Duplicates (same phone, not lost) are attached to the existing lead and its owner is told.
 * New leads are assigned round-robin to the sales executives of that project.
 */
export async function intakeLead(input: IntakeInput, actor: Actor) {
  const phone = normPhone(input.phone);
  if (phone.length !== 10) throw new Error("Enter a valid 10-digit mobile number");
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");

  return db.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({ where: { phone, stage: { not: "LOST" } }, orderBy: { createdAt: "desc" } });
    if (existing) {
      await tx.lead.update({ where: { id: existing.id }, data: { duplicateCount: { increment: 1 }, lastActivityAt: new Date() } });
      await tx.activity.create({
        data: { leadId: existing.id, type: "SYSTEM", note: `Enquired again via ${LEAD_SOURCES[input.source] ?? input.source}. The owner has been notified.` },
      });
      await audit(actor, "UPDATE", "Lead", existing.id, `Duplicate enquiry from ${name} (${phone}) via ${input.source} attached to existing lead`, undefined, tx);
      return { duplicate: true as const, lead: existing };
    }

    const ownerId = input.projectId ? await nextOwner(tx, input.projectId) : null;
    const lead = await tx.lead.create({
      data: {
        name,
        phone,
        email: input.email?.trim() || null,
        projectId: input.projectId || null,
        source: input.source,
        campaign: input.campaign || null,
        channelPartnerId: input.channelPartnerId || null,
        preferredType: input.preferredType || null,
        budget: input.budget || null,
        purpose: input.purpose || null,
        timeline: input.timeline || null,
        notes: input.notes || null,
        consentAt: input.consentAt ?? null,
        ownerId,
        lastActivityAt: new Date(),
      },
    });
    if (input.notes) await tx.activity.create({ data: { leadId: lead.id, userId: actor?.id ?? null, type: "NOTE", note: input.notes } });
    await audit(actor, "CREATE", "Lead", lead.id, `New lead ${name} via ${LEAD_SOURCES[input.source] ?? input.source}`, { after: { phone, source: input.source, ownerId } }, tx);
    return { duplicate: false as const, lead };
  });
}

/** Round-robin: the sales executive on this project who was assigned longest ago (never assigned first). */
async function nextOwner(tx: Prisma.TransactionClient, projectId: string) {
  const execs = await tx.user.findMany({
    where: { role: "SALES_EXEC", active: true, access: { some: { projectId } } },
    orderBy: [{ lastAssignedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  const pick = execs[0];
  if (!pick) return null;
  await tx.user.update({ where: { id: pick.id }, data: { lastAssignedAt: new Date() } });
  return pick.id;
}

/** Hour of the day in India, 0–23. */
export function istHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(d));
}

export function inBusinessHours(d = new Date()) {
  const h = istHour(d);
  return h >= ESCALATION.startHour && h < ESCALATION.endHour;
}

/** Minutes a lead has been waiting for its first call, or null if it has been called. */
export function waitingMinutes(l: { firstCallAt: Date | null; createdAt: Date; stage: string }) {
  if (l.firstCallAt || l.stage === "LOST") return null;
  return Math.floor((Date.now() - l.createdAt.getTime()) / 60000);
}

/** Red flag rule lives in lib/mis.ts so the dashboard and Sales agree. */
export { needsEscalation } from "./mis";

/** Which leads can this user see? Executives see their own; others see their projects. */
export function leadScope(u: CurrentUser): Prisma.LeadWhereInput {
  if (u.role === "SALES_EXEC") return { ownerId: u.id };
  return projectScope(u);
}

/** A block whose time has run out counts as available. */
export function effectiveStatus(u: { status: string; blockedUntil: Date | null }) {
  if (u.status === "BLOCKED" && u.blockedUntil && u.blockedUntil.getTime() < Date.now()) return "AVAILABLE";
  return u.status;
}

/** Release a lapsed block in the database (called lazily by actions). */
export async function releaseIfExpired(tx: Prisma.TransactionClient, unitId: string) {
  const u = await tx.unit.findUniqueOrThrow({ where: { id: unitId } });
  if (u.status === "BLOCKED" && u.blockedUntil && u.blockedUntil.getTime() < Date.now()) {
    const fresh = await tx.unit.update({ where: { id: unitId }, data: { status: "AVAILABLE", blockedById: null, blockedLeadId: null, blockedUntil: null } });
    await audit(null, "UPDATE", "Unit", unitId, `Block on ${u.number} expired and was released`, undefined, tx);
    return fresh;
  }
  return u;
}

export { db };
