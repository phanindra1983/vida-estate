import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { raiseMilestoneDemands } from "./collections";
import type { CurrentUser } from "./auth";
import { APPROVAL_ACTIONS } from "./constants";

type Tx = Prisma.TransactionClient;
type Actor = Pick<CurrentUser, "id" | "name" | "role">;

/** Which levels of the delegation-of-authority chain does this amount need? */
export async function requiredLevels(tx: Tx | typeof db, action: string, amount: number) {
  const rules = await tx.approvalRule.findMany({ where: { action }, orderBy: { level: "asc" } });
  const out: typeof rules = [];
  for (const r of rules) {
    out.push(r);
    if (r.upToAmount == null || amount <= r.upToAmount) break;
  }
  return out;
}

export async function createApproval(
  tx: Tx,
  input: { action: string; entityType: string; entityId: string; title: string; amount: number; projectId?: string | null },
  user: Actor,
) {
  const all = await tx.approvalRule.findMany({ where: { action: input.action }, orderBy: { level: "asc" } });
  let levels = await requiredLevels(tx, input.action, input.amount);
  if (levels.length === 0) throw new Error(`No approval rule configured for ${input.action}`);
  // Nobody approves their own request: skip levels held by the requester's own role,
  // and if that leaves nothing, escalate to the next level up.
  let chain = levels.filter((l) => l.role !== user.role);
  if (chain.length === 0) {
    const above = all.find((r) => r.level > levels[levels.length - 1].level && r.role !== user.role);
    if (!above) throw new Error("There is no one above you in the approval chain for this request. Change the approval limits first.");
    chain = [above];
  }
  levels = chain;
  const req = await tx.approvalRequest.create({
    data: {
      ...input, projectId: input.projectId ?? null, requestedById: user.id,
      currentLevel: levels[0].level, requiredLevel: levels[levels.length - 1].level,
    },
  });
  await audit(user, "CREATE", "ApprovalRequest", req.id,
    `Requested ${APPROVAL_ACTIONS[input.action] ?? input.action} approval: ${input.title} (${levels.map((l) => l.role).join(" → ")})`, undefined, tx);
  return req;
}

/** The role that must act on this request now. */
export async function pendingRole(tx: Tx | typeof db, req: { action: string; currentLevel: number }) {
  const r = await tx.approvalRule.findUnique({ where: { action_level: { action: req.action, level: req.currentLevel } } });
  return r?.role ?? null;
}

export async function canDecide(user: Actor, req: { action: string; currentLevel: number; status: string; requestedById: string }) {
  if (req.status !== "PENDING") return { ok: false, why: "Already decided" };
  if (req.requestedById === user.id) return { ok: false, why: "You raised this request, so someone else must approve it" };
  const role = await pendingRole(db, req);
  if (role !== user.role) return { ok: false, why: `Waiting for ${role}` };
  return { ok: true, why: "" };
}

export async function decide(requestId: string, user: Actor, decision: "APPROVED" | "REJECTED", comment?: string) {
  const result = await db.$transaction(async (tx) => {
    const req = await tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
    const check = await canDecide(user, req);
    if (!check.ok) throw new Error(check.why);
    await tx.approvalStep.create({
      data: { requestId, level: req.currentLevel, role: user.role, decision, comment: comment || null, decidedById: user.id },
    });
    if (decision === "REJECTED") {
      await tx.approvalRequest.update({ where: { id: requestId }, data: { status: "REJECTED", decidedAt: new Date() } });
      await audit(user, "REJECT", req.entityType, req.entityId, `Rejected: ${req.title}${comment ? ` (${comment})` : ""}`, undefined, tx);
      await onRejected(tx, req, user);
      return "REJECTED";
    }
    if (req.currentLevel < req.requiredLevel) {
      await tx.approvalRequest.update({ where: { id: requestId }, data: { currentLevel: req.currentLevel + 1 } });
      await audit(user, "APPROVE", req.entityType, req.entityId, `Approved level ${req.currentLevel}: ${req.title}`, undefined, tx);
      return "NEXT_LEVEL";
    }
    await tx.approvalRequest.update({ where: { id: requestId }, data: { status: "APPROVED", decidedAt: new Date() } });
    await audit(user, "APPROVE", req.entityType, req.entityId, `Final approval: ${req.title}`, undefined, tx);
    await onApproved(tx, req, user);
    return "APPROVED";
  });
  // Messages go out after the decision is safely saved.
  if (result === "APPROVED") {
    const req = await db.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (req.action === "RFQ_AWARD") await (await import("./procurement")).notifyAward(req.entityId);
  }
  return result;
}

type Req = { action: string; entityId: string; amount: number; projectId: string | null; title: string };

async function onApproved(tx: Tx, req: Req, user: Actor) {
  switch (req.action) {
    case "PURCHASE_ORDER":
      await tx.purchaseOrder.update({ where: { id: req.entityId }, data: { status: "APPROVED" } });
      break;
    case "BUDGET_REVISION": {
      const rev = await tx.budgetRevision.update({ where: { id: req.entityId }, data: { status: "APPROVED" } });
      const line = await tx.budgetLine.update({
        where: { id: rev.budgetLineId },
        data: { amount: rev.newAmount, revision: { increment: 1 } },
      });
      await audit(user, "UPDATE", "BudgetLine", line.id, `Budget revised to ₹${rev.newAmount.toLocaleString("en-IN")}`,
        { before: { amount: rev.oldAmount }, after: { amount: rev.newAmount } }, tx);
      if (rev.triggeredByPo) {
        const po = await tx.purchaseOrder.update({ where: { id: rev.triggeredByPo }, data: { status: "PENDING_APPROVAL" } });
        await createApproval(tx, {
          action: "PURCHASE_ORDER", entityType: "PurchaseOrder", entityId: po.id,
          title: `${po.number} · ${po.item}`, amount: po.amount, projectId: po.projectId,
        }, { id: rev.requestedById, name: "System", role: "SYSTEM" });
      }
      break;
    }
    case "VENDOR_PAYMENT":
      await tx.vendorBill.update({ where: { id: req.entityId }, data: { status: "PAID", paidAt: new Date() } });
      break;
    case "PAYOUT":
      await tx.payout.update({ where: { id: req.entityId }, data: { status: "APPROVED" } });
      break;
    case "RFQ_AWARD":
      await (await import("./procurement")).awardRfq(tx, req.entityId, user);
      break;
    case "MILESTONE": {
      await tx.milestone.update({ where: { id: req.entityId }, data: { status: "DONE", progressPct: 100, actualEnd: new Date() } });
      await raiseMilestoneDemands(tx, req.entityId, user);
      break;
    }
  }
}

async function onRejected(tx: Tx, req: Req, _user: Actor) {
  switch (req.action) {
    case "PURCHASE_ORDER":
      await tx.purchaseOrder.update({ where: { id: req.entityId }, data: { status: "REJECTED" } });
      break;
    case "BUDGET_REVISION": {
      const rev = await tx.budgetRevision.update({ where: { id: req.entityId }, data: { status: "REJECTED" } });
      if (rev.triggeredByPo) await tx.purchaseOrder.update({ where: { id: rev.triggeredByPo }, data: { status: "REJECTED" } });
      break;
    }
    case "VENDOR_PAYMENT":
      await tx.vendorBill.update({ where: { id: req.entityId }, data: { status: "PAYABLE" } });
      break;
    case "PAYOUT":
      await tx.payout.update({ where: { id: req.entityId }, data: { status: "REJECTED" } });
      break;
    case "MILESTONE":
      await tx.milestone.update({ where: { id: req.entityId }, data: { status: "IN_PROGRESS" } });
      break;
    case "RFQ_AWARD":
      // Back to the comparison so the purchase team can choose another vendor.
      await tx.rfq.update({ where: { id: req.entityId }, data: { status: "READY", note: "Award rejected by the approver. Choose a vendor and send again." } });
      break;
  }
}
