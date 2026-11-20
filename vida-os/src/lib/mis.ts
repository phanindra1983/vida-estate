import { db } from "./db";
import { ESCALATION } from "./constants";

/** Statuses that count as money committed against a budget line. */
export const COMMITTED_PO = ["PENDING_APPROVAL", "APPROVED", "PARTLY_RECEIVED", "RECEIVED", "CLOSED"];
/** Statuses that count as actual cost booked. */
export const ACTUAL_BILL = ["PAYABLE", "IN_PAYMENT", "PAID"];

export type BudgetRow = {
  lineId: string; costCodeId: string; code: string; name: string;
  budget: number; committed: number; actual: number; available: number; usedPct: number;
};

/** Budget vs committed vs actual for one project, one row per cost code. Shared by Cost and the dashboard. */
export async function budgetPosition(projectId: string): Promise<BudgetRow[]> {
  const [lines, pos, bills] = await Promise.all([
    db.budgetLine.findMany({ where: { projectId }, include: { costCode: true }, orderBy: { costCode: { code: "asc" } } }),
    db.purchaseOrder.groupBy({ by: ["costCodeId"], where: { projectId, status: { in: COMMITTED_PO } }, _sum: { amount: true } }),
    db.vendorBill.findMany({ where: { status: { in: ACTUAL_BILL }, po: { projectId } }, select: { amount: true, po: { select: { costCodeId: true } } } }),
  ]);
  return lines.map((l) => {
    const committed = pos.find((p) => p.costCodeId === l.costCodeId)?._sum.amount ?? 0;
    const actual = bills.filter((b) => b.po.costCodeId === l.costCodeId).reduce((s, b) => s + b.amount, 0);
    return {
      lineId: l.id, costCodeId: l.costCodeId, code: l.costCode.code, name: l.costCode.name,
      budget: l.amount, committed, actual, available: l.amount - committed,
      usedPct: l.amount ? Math.round((committed / l.amount) * 100) : 0,
    };
  });
}

/** True when a lead has waited longer than the escalation window for its first call (counting only business hours start). */
export function needsEscalation(lead: { firstCallAt: Date | null; createdAt: Date; stage: string }, now = new Date()) {
  if (lead.firstCallAt || lead.stage === "LOST") return false;
  const waited = (now.getTime() - lead.createdAt.getTime()) / 60000;
  const h = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(now));
  return waited > ESCALATION.minutes && h >= ESCALATION.startHour && h < ESCALATION.endHour;
}

export async function projectSnapshot(projectIds: string[] | "ALL") {
  const where = projectIds === "ALL" ? {} : { id: { in: projectIds } };
  const projects = await db.project.findMany({ where, orderBy: { name: "asc" } });
  const now = Date.now();
  return Promise.all(projects.map(async (p) => {
    const [units, bookings, demands, receipts, milestones, budget] = await Promise.all([
      db.unit.groupBy({ by: ["status"], where: { projectId: p.id }, _count: true }),
      db.booking.findMany({ where: { unit: { projectId: p.id }, status: { not: "CANCELLED" } }, select: { agreementValue: true, bookedAt: true } }),
      db.demand.findMany({ where: { booking: { unit: { projectId: p.id } } }, select: { amount: true, dueDate: true, status: true, receipts: { select: { amount: true } } } }),
      db.receipt.aggregate({ where: { booking: { unit: { projectId: p.id } } }, _sum: { amount: true } }),
      db.milestone.findMany({ where: { projectId: p.id }, include: { tower: true }, orderBy: [{ towerId: "asc" }, { seq: "asc" }] }),
      budgetPosition(p.id),
    ]);
    const count = (s: string) => units.find((u) => u.status === s)?._count ?? 0;
    const totalUnits = units.reduce((s, u) => s + u._count, 0);
    const demanded = demands.reduce((s, d) => s + d.amount, 0);
    const overdue = demands
      .filter((d) => d.status !== "PAID" && d.dueDate.getTime() < now)
      .reduce((s, d) => s + d.amount - d.receipts.reduce((a, r) => a + r.amount, 0), 0);
    const active = milestones.filter((m) => m.status !== "DONE");
    const delayed = active.filter((m) => m.plannedEnd.getTime() < now - 3 * 864e5);
    const current = active.filter((m) => m.status !== "NOT_STARTED");
    const last30 = bookings.filter((b) => b.bookedAt.getTime() > now - 30 * 864e5);
    return {
      project: p,
      units: { total: totalUnits, booked: count("BOOKED"), blocked: count("BLOCKED"), available: count("AVAILABLE") },
      salesValue: bookings.reduce((s, b) => s + b.agreementValue, 0),
      bookings30: last30.length,
      demanded,
      collected: receipts._sum.amount ?? 0,
      overdue,
      budget: {
        total: budget.reduce((s, r) => s + r.budget, 0),
        committed: budget.reduce((s, r) => s + r.committed, 0),
        actual: budget.reduce((s, r) => s + r.actual, 0),
        rows: budget,
      },
      schedule: { current, delayed, done: milestones.filter((m) => m.status === "DONE").length, total: milestones.length },
    };
  }));
}
