import { db } from "./db";
import { audit } from "./audit";
import { docNo } from "./format";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;
const DUE_DAYS = 15;

async function nextDemandNo(tx: Tx, projectCode: string) {
  const n = await tx.demand.count({ where: { booking: { unit: { project: { code: projectCode } } } } });
  return docNo("DL", projectCode, n + 1);
}

/** Raise demands for all plan stages that are due on booking (no milestone). */
export async function raiseBookingDemands(tx: Tx, bookingId: string) {
  const b = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { plan: { include: { stages: true } }, unit: { include: { project: true } } },
  });
  for (const st of b.plan.stages.filter((s) => !s.milestoneKey)) {
    await tx.demand.create({
      data: {
        bookingId: b.id,
        planStageId: st.id,
        number: await nextDemandNo(tx, b.unit.project.code),
        amount: Math.round((b.agreementValue * st.pct) / 100),
        dueDate: new Date(Date.now() + DUE_DAYS * 864e5),
      },
    });
  }
}

/**
 * When a milestone is approved as complete, raise demand letters for every
 * active booking in that tower (or the whole project if the milestone has no tower)
 * whose payment plan has a stage linked to this milestone key.
 */
export async function raiseMilestoneDemands(tx: Tx, milestoneId: string, user: { id: string; name: string }) {
  const m = await tx.milestone.findUniqueOrThrow({ where: { id: milestoneId }, include: { project: true } });
  const bookings = await tx.booking.findMany({
    where: {
      status: { not: "CANCELLED" },
      unit: { projectId: m.projectId, ...(m.towerId ? { towerId: m.towerId } : {}) },
    },
    include: { plan: { include: { stages: true } }, demands: true },
  });
  let raised = 0;
  for (const b of bookings) {
    for (const st of b.plan.stages.filter((s) => s.milestoneKey === m.key)) {
      if (b.demands.some((d) => d.planStageId === st.id)) continue;
      await tx.demand.create({
        data: {
          bookingId: b.id,
          planStageId: st.id,
          number: await nextDemandNo(tx, m.project.code),
          amount: Math.round((b.agreementValue * st.pct) / 100),
          dueDate: new Date(Date.now() + DUE_DAYS * 864e5),
        },
      });
      raised++;
    }
  }
  await audit(user, "CREATE", "Demand", m.id, `Raised ${raised} demand letter(s) on completion of "${m.name}"`, undefined, tx);
  return raised;
}

/** Recompute a demand's status from its receipts. */
export async function refreshDemand(tx: Tx, demandId: string) {
  const d = await tx.demand.findUniqueOrThrow({ where: { id: demandId }, include: { receipts: true } });
  const paid = d.receipts.reduce((s, r) => s + r.amount, 0);
  const status = paid >= d.amount ? "PAID" : paid > 0 ? "PART_PAID" : "DUE";
  if (status !== d.status) await tx.demand.update({ where: { id: d.id }, data: { status } });
}

export function isOverdue(d: { status: string; dueDate: Date }) {
  return d.status !== "PAID" && d.dueDate.getTime() < Date.now();
}

export { db };
