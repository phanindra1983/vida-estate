import { db } from "./db";
import { budgetPosition } from "./mis";
import { defaultRate, monthEnd, currentYM } from "./performance";

/**
 * Key controls, tested automatically, the way an internal-audit control register works:
 * each control has the risk it covers, an owner, how often it runs, a target and today's result.
 * 🟢 meets target · 🟡 close · 🔴 breached. Every red has a link to the records behind it.
 */
export type ControlResult = {
  id: string; area: "Sales" | "Collections" | "Projects" | "Cost" | "Governance" | "People";
  name: string; risk: string; owner: string; frequency: string;
  target: string; result: string; rag: "GREEN" | "AMBER" | "RED"; link?: string;
};

const pct = (a: number, b: number) => (b ? (a / b) * 100 : 100);
const ragHigh = (v: number, green: number, amber: number) => (v >= green ? "GREEN" : v >= amber ? "AMBER" : "RED") as ControlResult["rag"];
const ragZero = (n: number, amberUpTo = 2) => (n === 0 ? "GREEN" : n <= amberUpTo ? "AMBER" : "RED") as ControlResult["rag"];
const DAY = 864e5;

export async function runControls(projectIds: string[] | "ALL"): Promise<ControlResult[]> {
  const pScope = projectIds === "ALL" ? {} : { projectId: { in: projectIds } };
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY);
  const { year, month } = currentYM();

  const [
    leads30, lostNoReason, staleVisits, expiredHolds, belowList, discountApprovals, dr, drTarget,
    ucProjects, reports7, lateMilestones, openSafety, budgetHolds, mismatchBills, bills90, steps, oldApprovals, staff,
  ] = await Promise.all([
    db.lead.findMany({ where: { ...pScope, createdAt: { gte: since30, lt: new Date(now - 15 * 60e3) } }, select: { createdAt: true, firstCallAt: true } }),
    db.lead.count({ where: { ...pScope, stage: "LOST", OR: [{ lostReason: null }, { lostReason: "" }] } }),
    db.activity.findMany({ where: { type: "SITE_VISIT", scheduledFor: { lt: new Date(now - DAY), gt: new Date(now - 60 * DAY) }, lead: { ...pScope, stage: "VISIT_SCHEDULED" } }, select: { leadId: true }, distinct: ["leadId"] }),
    db.unit.count({ where: { ...pScope, status: "BLOCKED", blockedUntil: { lt: new Date() } } }),
    db.booking.findMany({ where: { status: { not: "CANCELLED" }, unit: pScope }, select: { id: true, agreementValue: true, unit: { select: { price: true } } } }),
    db.approvalRequest.findMany({ where: { action: "DISCOUNT", status: "APPROVED" }, select: { entityId: true } }),
    defaultRate(monthEnd(year, month), projectIds),
    db.planTarget.findFirst({ where: { year, month: 0, projectId: "", kpi: "DEFAULT_RATE" } }),
    db.project.findMany({ where: { ...(projectIds === "ALL" ? {} : { id: { in: projectIds } }), status: "UNDER_CONSTRUCTION" }, select: { id: true, name: true } }),
    db.dailyReport.findMany({ where: { ...pScope, date: { gte: new Date(now - 7 * DAY) } }, select: { projectId: true, date: true } }),
    db.milestone.count({ where: { ...pScope, status: { not: "DONE" }, plannedEnd: { lt: new Date(now - 7 * DAY) } } }),
    db.siteIssue.count({ where: { ...pScope, kind: "SAFETY", status: "OPEN", createdAt: { lt: new Date(now - 2 * DAY) } } }),
    db.purchaseOrder.count({ where: { ...pScope, status: "BUDGET_HOLD" } }),
    db.vendorBill.count({ where: { match: "MISMATCH", status: { notIn: ["ON_HOLD"] } } }),
    db.vendorBill.findMany({ where: { createdAt: { gte: new Date(now - 90 * DAY) } }, select: { match: true } }),
    db.approvalStep.findMany({ where: { decidedAt: { gte: new Date(now - 90 * DAY) } }, select: { decidedById: true, request: { select: { requestedById: true } } } }),
    db.approvalRequest.count({ where: { status: "PENDING", createdAt: { lt: new Date(now - 3 * DAY) } } }),
    db.user.findMany({ where: { active: true }, select: { telegramChatId: true } }),
  ]);

  // Budget: cost lines where orders already exceed the budget.
  const overBudgetLines = (await Promise.all(ucProjects.map((p) => budgetPosition(p.id)))).flat().filter((r) => r.committed > r.budget).length;

  // First call within 15 minutes (leads that are at least 15 minutes old).
  const fast = leads30.filter((l) => l.firstCallAt && l.firstCallAt.getTime() - l.createdAt.getTime() <= 15 * 60e3).length;
  const fastPct = pct(fast, leads30.length);

  // Discounts: bookings below list price must carry an approved discount request.
  const approved = new Set(discountApprovals.map((a) => a.entityId));
  const unapprovedDiscounts = belowList.filter((b) => b.agreementValue < b.unit.price * 0.995 && !approved.has(b.id)).length;

  // Daily site reports: each project under construction, each of the last 6 working days (Mon–Sat).
  const days: string[] = [];
  for (let i = 1; days.length < 6 && i < 14; i++) {
    const d = new Date(now - i * DAY);
    if (d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" }) !== "Sun") days.push(d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  }
  const reported = new Set(reports7.map((r) => `${r.projectId}:${r.date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}`));
  const expected = ucProjects.length * days.length;
  const filed = ucProjects.reduce((s, p) => s + days.filter((d) => reported.has(`${p.id}:${d}`)).length, 0);
  const reportPct = pct(filed, expected);

  const matchedPct = pct(bills90.filter((b) => b.match === "MATCHED").length, bills90.length);
  const selfApproved = steps.filter((s) => s.decidedById === s.request.requestedById).length;
  const linkedPct = pct(staff.filter((s) => s.telegramChatId).length, staff.length);
  const drLimit = drTarget?.value || 1;

  return [
    { id: "S1", area: "Sales", name: "New leads called within 15 minutes", risk: "Buyers go cold and call competitors", owner: "Sales head", frequency: "Every lead", target: "90% or more", result: `${fastPct.toFixed(0)}% (${fast} of ${leads30.length}, last 30 days)`, rag: ragHigh(fastPct, 90, 70), link: "/sales/leads?view=firstcall" },
    { id: "S2", area: "Sales", name: "Every lost lead has a reason", risk: "No learning from losses", owner: "Sales head", frequency: "Every lost lead", target: "0 without a reason", result: `${lostNoReason} without a reason`, rag: ragZero(lostNoReason), link: "/sales/leads?view=lost" },
    { id: "S3", area: "Sales", name: "Site visits marked came / no-show within a day", risk: "No-shows never followed up", owner: "Sales manager", frequency: "Daily", target: "0 unmarked", result: `${staleVisits.length} unmarked`, rag: ragZero(staleVisits.length), link: "/sales/visits" },
    { id: "S4", area: "Sales", name: "Discounts below list price approved", risk: "Revenue leakage through unapproved discounts", owner: "MD", frequency: "Every booking", target: "0 unapproved", result: `${unapprovedDiscounts} booking${unapprovedDiscounts === 1 ? "" : "s"} below list without approval`, rag: unapprovedDiscounts ? "RED" : "GREEN", link: "/sales/bookings" },
    { id: "S5", area: "Sales", name: "Expired unit holds released", risk: "Units held for buyers who never booked", owner: "Sales manager", frequency: "Continuous (auto after 48 h)", target: "0 expired holds", result: `${expiredHolds} expired hold${expiredHolds === 1 ? "" : "s"} still marked`, rag: expiredHolds ? "AMBER" : "GREEN", link: "/sales/inventory" },
    { id: "C1", area: "Collections", name: "Default rate (unpaid 90+ days) within target", risk: "Cash shortfall, bad debts", owner: "Finance head", frequency: "Monthly", target: `${drLimit}% or less`, result: `${dr.pct.toFixed(2)}% (₹${(dr.over90 / 1e5).toFixed(1)} L)`, rag: dr.pct <= drLimit ? "GREEN" : dr.pct <= drLimit * 1.25 ? "AMBER" : "RED", link: "/sales/collections" },
    { id: "P1", area: "Projects", name: "Daily site report from every site", risk: "Delays seen weeks too late", owner: "Project managers", frequency: "Daily (Mon–Sat)", target: "100%", result: expected ? `${reportPct.toFixed(0)}% (${filed} of ${expected} site-days, last 6 working days)` : "No project under construction", rag: expected ? ragHigh(reportPct, 100, 80) : "GREEN", link: "/projects/reports" },
    { id: "P2", area: "Projects", name: "Construction stages on schedule", risk: "RERA delay interest, buyer trust", owner: "GM Projects", frequency: "Weekly", target: "0 stages late by 7+ days", result: `${lateMilestones} stage${lateMilestones === 1 ? "" : "s"} late`, rag: ragZero(lateMilestones, 1), link: "/projects/schedule" },
    { id: "P3", area: "Projects", name: "Safety issues closed within 2 days", risk: "Accidents, legal exposure", owner: "Project managers", frequency: "Continuous", target: "0 open past 2 days", result: `${openSafety} open`, rag: openSafety ? "RED" : "GREEN", link: "/projects/issues" },
    { id: "K1", area: "Cost", name: "No order above budget", risk: "Cost overrun", owner: "GM Projects / Finance", frequency: "Every order", target: "0 cost lines over budget", result: `${overBudgetLines} cost line${overBudgetLines === 1 ? "" : "s"} over budget · ${budgetHolds} order${budgetHolds === 1 ? "" : "s"} held for budget`, rag: overBudgetLines ? "RED" : budgetHolds ? "AMBER" : "GREEN", link: "/cost/budgets" },
    { id: "K2", area: "Cost", name: "Bills match order and goods received (3-way match)", risk: "Paying for more than ordered or received", owner: "Accounts", frequency: "Every bill", target: "100% matched, mismatches on hold", result: `${matchedPct.toFixed(0)}% matched (90 days) · ${mismatchBills} mismatch${mismatchBills === 1 ? "" : "es"} not on hold`, rag: mismatchBills ? "RED" : ragHigh(matchedPct, 95, 85), link: "/cost/bills" },
    { id: "G1", area: "Governance", name: "Nobody approves their own request", risk: "Fraud, segregation of duties", owner: "MD", frequency: "Every approval", target: "0", result: `${selfApproved} self-approval${selfApproved === 1 ? "" : "s"} (90 days)`, rag: selfApproved ? "RED" : "GREEN", link: "/control/audit" },
    { id: "G2", area: "Governance", name: "Approvals decided within 3 days", risk: "Site and buying stall", owner: "Approvers", frequency: "Daily", target: "0 waiting past 3 days", result: `${oldApprovals} waiting`, rag: ragZero(oldApprovals), link: "/approvals" },
    { id: "H1", area: "People", name: "Staff linked to the Telegram bot", risk: "Alerts and reminders reach nobody", owner: "HR / MD", frequency: "Weekly", target: "100%", result: `${linkedPct.toFixed(0)}% (${staff.filter((s) => s.telegramChatId).length} of ${staff.length})`, rag: ragHigh(linkedPct, 100, 80), link: "/control/telegram" },
  ];
}
