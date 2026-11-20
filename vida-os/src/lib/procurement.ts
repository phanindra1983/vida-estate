import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { createApproval } from "./approvals";
import { COMMITTED_PO } from "./mis";
import { docNo, inr, date } from "./format";
import { sendEmail, queueWhatsApp, publicUrl } from "./notify";

type Tx = Prisma.TransactionClient;
const DAY = 864e5;

/** Days kept for comparison, approval and issuing the PO between quotes closing and the order date. */
export const APPROVAL_DAYS = 3;
/** Most vendors invited per enquiry. */
export const MAX_INVITES = 5;
/** The engine runs by itself at most this often when someone opens the procurement screens. */
const AUTO_RUN_MINUTES = 10;

export const SYSTEM = { id: "SYSTEM", name: "Procurement engine", role: "SYSTEM" };

// ───────────── timing ─────────────

export type Timing = { needOnSite: Date; orderBy: Date; sendOn: Date };

/** Work back from the milestone start: on site by, order by, send enquiries on. */
export function timing(milestoneStart: Date, req: { neededDaysBeforeStart: number }, mat: { leadTimeDays: number; quoteDays: number }): Timing {
  const needOnSite = new Date(milestoneStart.getTime() - req.neededDaysBeforeStart * DAY);
  const orderBy = new Date(needOnSite.getTime() - mat.leadTimeDays * DAY);
  const sendOn = new Date(orderBy.getTime() - (mat.quoteDays + APPROVAL_DAYS) * DAY);
  return { needOnSite, orderBy, sendOn };
}

const ACTIVE = ["SENT", "READY", "IN_APPROVAL", "AWARDED"];

export type PlanRow = {
  reqId: string; project: { id: string; name: string; code: string }; milestone: { id: string; name: string; plannedStart: Date; status: string };
  material: { id: string; name: string; unit: string; leadTimeDays: number; category: string }; qty: number;
  t: Timing; rfq: { id: string; number: string; status: string; quotes: number; invites: number } | null;
  state: "PLANNED" | "DUE" | "OUT" | "READY" | "APPROVAL" | "ORDERED"; late: boolean;
};

/** The procurement plan: one row per material need, with its dates and where it stands. */
export async function procurementPlan(projectIds: string[] | "ALL"): Promise<PlanRow[]> {
  const reqs = await db.materialRequirement.findMany({
    where: projectIds === "ALL" ? {} : { projectId: { in: projectIds } },
    include: { material: true, rfqs: { where: { status: { in: ACTIVE } }, include: { _count: { select: { quotes: true, invites: true } } }, orderBy: { createdAt: "desc" } } },
  });
  const milestones = new Map((await db.milestone.findMany({ where: { id: { in: reqs.map((r) => r.milestoneId) } } })).map((m) => [m.id, m]));
  const projects = new Map((await db.project.findMany()).map((p) => [p.id, p]));
  const now = Date.now();
  const rows: PlanRow[] = [];
  for (const r of reqs) {
    const m = milestones.get(r.milestoneId);
    const p = projects.get(r.projectId);
    if (!m || !p || m.status === "DONE") continue;
    const t = timing(m.plannedStart, r, r.material);
    const rf = r.rfqs[0] ?? null;
    const state: PlanRow["state"] = !rf ? (now >= t.sendOn.getTime() ? "DUE" : "PLANNED")
      : rf.status === "AWARDED" ? "ORDERED" : rf.status === "IN_APPROVAL" ? "APPROVAL" : rf.status === "READY" ? "READY" : "OUT";
    rows.push({
      reqId: r.id, project: { id: p.id, name: p.name, code: p.code },
      milestone: { id: m.id, name: m.name, plannedStart: m.plannedStart, status: m.status },
      material: { id: r.material.id, name: r.material.name, unit: r.material.unit, leadTimeDays: r.material.leadTimeDays, category: r.material.category },
      qty: r.qty, t,
      rfq: rf ? { id: rf.id, number: rf.number, status: rf.status, quotes: rf._count.quotes, invites: rf._count.invites } : null,
      state, late: state !== "ORDERED" && now > t.orderBy.getTime(),
    });
  }
  return rows.sort((a, b) => a.t.sendOn.getTime() - b.t.sendOn.getTime());
}

// ───────────── comparison ─────────────

export type CompareRow = {
  quoteId: string; vendorId: string; vendor: string; rating: number; rate: number; gstPct: number; freight: number;
  basic: number; gst: number; landed: number; deliveryDays: number; arrives: Date; lateBy: number; paymentTerms: string | null;
  validityDays: number; remarks: string | null; vsRef: number | null; score: number; rank: number; recommended: boolean;
};

/**
 * Comparison statement. Landed cost = qty × rate + GST + freight. Score out of 100:
 * price 70 (cheapest gets 70), delivery 20 (on time gets 20, minus 2 a day late), vendor rating 10.
 */
export async function comparison(rfqId: string) {
  const rfq = await db.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: { material: true, quotes: true } });
  const vendors = new Map((await db.vendor.findMany({ where: { id: { in: rfq.quotes.map((q) => q.vendorId) } } })).map((v) => [v.id, v]));
  const awardBase = Date.now() + APPROVAL_DAYS * DAY;
  const rows: CompareRow[] = rfq.quotes.map((q) => {
    const basic = Math.round(rfq.qty * q.rate);
    const gst = Math.round(((basic + q.freight) * q.gstPct) / 100);
    const landed = basic + q.freight + gst;
    const arrives = new Date(Math.max(awardBase, Date.now()) + q.deliveryDays * DAY);
    const lateBy = Math.max(0, Math.ceil((arrives.getTime() - rfq.needOnSite.getTime()) / DAY));
    const v = vendors.get(q.vendorId);
    return {
      quoteId: q.id, vendorId: q.vendorId, vendor: v?.name ?? "Vendor", rating: v?.rating ?? 3, rate: q.rate, gstPct: q.gstPct, freight: q.freight,
      basic, gst, landed, deliveryDays: q.deliveryDays, arrives, lateBy, paymentTerms: q.paymentTerms, validityDays: q.validityDays, remarks: q.remarks,
      vsRef: rfq.material.refRate ? Math.round(((q.rate - rfq.material.refRate) / rfq.material.refRate) * 1000) / 10 : null,
      score: 0, rank: 0, recommended: false,
    };
  });
  const min = Math.min(...rows.map((r) => r.landed));
  for (const r of rows) r.score = Math.round(((min / r.landed) * 70 + Math.max(0, 20 - r.lateBy * 2) + (r.rating / 5) * 10) * 10) / 10;
  rows.sort((a, b) => a.landed - b.landed);
  const best = [...rows].sort((a, b) => b.score - a.score)[0];
  rows.forEach((r, i) => { r.rank = i + 1; r.recommended = r === best; });
  return { rfq, rows, recommended: best ?? null };
}

// ───────────── sending enquiries ─────────────

function token() {
  return randomBytes(18).toString("base64url");
}

function enquiryText(o: { vendor: string; number: string; material: string; specs: string | null; qty: number; unit: string; site: string; needOnSite: Date; quoteDueAt: Date; link: string }) {
  return [
    `Dear ${o.vendor},`,
    ``,
    `Vida Estates invites your quotation for enquiry ${o.number}.`,
    ``,
    `Material: ${o.material}${o.specs ? ` (${o.specs})` : ""}`,
    `Quantity: ${o.qty.toLocaleString("en-IN")} ${o.unit}`,
    `Delivery to: ${o.site}`,
    `Needed on site by: ${date(o.needOnSite)}`,
    `Please quote by: ${date(o.quoteDueAt)}`,
    ``,
    `Submit your rate, GST, freight and delivery time here (takes 2 minutes): ${o.link}`,
    ``,
    `Thank you,`,
    `Purchase team, Vida Estates`,
  ].join("\n");
}

async function inviteVendors(rfqId: string, vendorIds?: string[]) {
  const rfq = await db.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: { material: true, invites: true } });
  const project = await db.project.findUniqueOrThrow({ where: { id: rfq.projectId } });
  const invited = new Set(rfq.invites.map((i) => i.vendorId));
  const vendors = vendorIds
    ? (await db.vendor.findMany({ where: { id: { in: vendorIds } } })).filter((v) => !invited.has(v.id))
    : (await db.vendor.findMany({ where: { category: rfq.material.category, active: true }, orderBy: [{ verified: "desc" }, { rating: "desc" }] }))
      .filter((v) => !invited.has(v.id)).slice(0, MAX_INVITES - invited.size);
  for (const v of vendors) {
    const inv = await db.rfqInvite.create({ data: { rfqId: rfq.id, vendorId: v.id, token: token() } });
    const text = enquiryText({
      vendor: v.name, number: rfq.number, material: rfq.material.name, specs: rfq.material.specs, qty: rfq.qty, unit: rfq.unit,
      site: `${project.name}, ${project.location}`, needOnSite: rfq.needOnSite, quoteDueAt: rfq.quoteDueAt, link: publicUrl(`/rfq/${inv.token}`),
    });
    const ref = { type: "RfqInvite", id: inv.id };
    if (v.email) await sendEmail(v.email, `Enquiry ${rfq.number}: ${rfq.material.name} for ${project.name}`, text, ref, { live: rfq.live });
    if (v.phone) await queueWhatsApp(v.phone, text, ref);
  }
  return vendors.length + invited.size;
}

/** Create an enquiry for one material need and send it to the matching vendors. */
export async function createRfq(reqId: string, actor: { id: string; name: string } = SYSTEM) {
  const r = await db.materialRequirement.findUniqueOrThrow({ where: { id: reqId }, include: { material: true } });
  const m = await db.milestone.findUniqueOrThrow({ where: { id: r.milestoneId } });
  const project = await db.project.findUniqueOrThrow({ where: { id: r.projectId } });
  const t = timing(m.plannedStart, r, r.material);
  const now = Date.now();
  // Quotes close after the quote window, but never later than the order date minus approval time, and never in under 2 days.
  const due = Math.max(now + 2 * DAY, Math.min(now + r.material.quoteDays * DAY, t.orderBy.getTime() - APPROVAL_DAYS * DAY));
  const n = (await db.rfq.count({ where: { projectId: project.id } })) + 1;
  const rfq = await db.rfq.create({
    data: {
      number: docNo("RFQ", project.code, n), projectId: project.id, requirementId: r.id, materialId: r.materialId, milestoneId: m.id,
      qty: r.qty, unit: r.material.unit, needOnSite: t.needOnSite, orderBy: t.orderBy, quoteDueAt: new Date(due), createdById: actor.id,
    },
  });
  const count = await inviteVendors(rfq.id);
  if (count < 3) await db.rfq.update({ where: { id: rfq.id }, data: { note: `Only ${count} vendor(s) in "${r.material.category}". Add more vendors for a fair comparison.` } });
  await audit(actor, "CREATE", "Rfq", rfq.id, `Sent enquiry ${rfq.number} for ${r.qty} ${r.material.unit} ${r.material.name} to ${count} vendor(s) (order by ${date(t.orderBy)})`);
  return rfq;
}

// ───────────── evaluating quotes ─────────────

/**
 * When every invited vendor has quoted, or quotes have closed with at least one quote,
 * build the comparison and send the recommended vendor for approval automatically
 * (needs at least 2 quotes; with a single quote the purchase team reviews it first).
 */
export async function evaluateRfq(rfqId: string) {
  const rfq = await db.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: { invites: true, quotes: true, material: true } });
  if (rfq.status !== "SENT") return null;
  const responded = rfq.invites.filter((i) => i.status === "QUOTED" || i.status === "DECLINED").length;
  const closed = Date.now() > rfq.quoteDueAt.getTime();
  if (!(responded >= rfq.invites.length || closed)) return null;
  if (rfq.quotes.length === 0) {
    // Nobody quoted: extend 2 days once and remind.
    if (!rfq.note?.includes("Extended")) {
      await db.rfq.update({ where: { id: rfq.id }, data: { quoteDueAt: new Date(Date.now() + 2 * DAY), note: `${rfq.note ? rfq.note + " " : ""}Extended 2 days: no quotes by the due date.` } });
      await remind(rfq.id, true);
    }
    return "EXTENDED";
  }
  const { recommended } = await comparison(rfq.id);
  await db.rfq.update({ where: { id: rfq.id }, data: { status: "READY", recommendedQuoteId: recommended?.quoteId ?? null } });
  await audit(SYSTEM, "UPDATE", "Rfq", rfq.id, `Comparison ready for ${rfq.number}: ${rfq.quotes.length} quote(s), recommended ${recommended?.vendor ?? "none"}`);
  if (rfq.quotes.length >= 2 && recommended) await submitAward(rfq.id, recommended.quoteId, SYSTEM);
  return "READY";
}

/** Send the chosen quote for approval through the delegation-of-authority chain. */
export async function submitAward(rfqId: string, quoteId: string, actor: { id: string; name: string; role: string }, reason?: string) {
  const { rfq, rows } = await comparison(rfqId);
  const q = rows.find((r) => r.quoteId === quoteId);
  if (!q) throw new Error("That quote is not part of this enquiry");
  if (!["READY", "REJECTED"].includes(rfq.status)) throw new Error("This enquiry is not waiting for a decision");
  await db.$transaction(async (tx) => {
    await tx.rfq.update({ where: { id: rfq.id }, data: { status: "IN_APPROVAL", recommendedQuoteId: quoteId } });
    await createApproval(tx, {
      action: "RFQ_AWARD", entityType: "Rfq", entityId: rfq.id,
      title: `${rfq.number} · ${rfq.material.name}: award to ${q.vendor}${q.recommended ? " (recommended)" : ""}`,
      amount: q.landed, projectId: rfq.projectId,
    }, actor);
    if (reason) await audit(actor, "UPDATE", "Rfq", rfq.id, `Chose ${q.vendor} instead of the recommendation: ${reason}`, undefined, tx);
  });
}

/** Called by the approval engine when an award is finally approved: raise the PO. */
export async function awardRfq(tx: Tx, rfqId: string, approver: { id: string; name: string }) {
  const rfq = await tx.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: { material: true, quotes: true } });
  const q = rfq.quotes.find((x) => x.id === rfq.recommendedQuoteId);
  if (!q) throw new Error("No quote selected for award");
  const project = await tx.project.findUniqueOrThrow({ where: { id: rfq.projectId } });
  const n = (await tx.purchaseOrder.count({ where: { projectId: project.id } })) + 1;
  const number = docNo("PO", project.code, n);
  const amount = Math.round((rfq.qty * q.rate + q.freight) * (1 + q.gstPct / 100));
  const line = await tx.budgetLine.findUnique({ where: { projectId_costCodeId: { projectId: project.id, costCodeId: rfq.material.costCodeId } }, include: { costCode: true } });
  const committed = (await tx.purchaseOrder.aggregate({ where: { projectId: project.id, costCodeId: rfq.material.costCodeId, status: { in: COMMITTED_PO } }, _sum: { amount: true } }))._sum.amount ?? 0;
  const over = !line || committed + amount > line.amount;
  const po = await tx.purchaseOrder.create({
    data: {
      number, projectId: project.id, costCodeId: rfq.material.costCodeId, vendorId: q.vendorId, item: `${rfq.material.name} (${rfq.number})`,
      qty: rfq.qty, unit: rfq.unit, rate: rfq.qty ? (rfq.qty * q.rate + q.freight) / rfq.qty : q.rate, gstPct: q.gstPct, amount,
      status: over ? "BUDGET_HOLD" : "APPROVED", createdById: rfq.createdById ?? "SYSTEM",
    },
  });
  await tx.rfq.update({ where: { id: rfq.id }, data: { status: "AWARDED", awardedQuoteId: q.id, poId: po.id } });
  await audit(approver, "CREATE", "PurchaseOrder", po.id, `${number} raised from ${rfq.number} (${inr(amount)})${over ? ", held for budget revision" : ""}`, undefined, tx);
  if (over && line) {
    const rev = await tx.budgetRevision.create({
      data: { budgetLineId: line.id, oldAmount: line.amount, newAmount: committed + amount, reason: `Needed for ${number} (${rfq.material.name})`, requestedById: rfq.createdById ?? "SYSTEM", triggeredByPo: po.id },
    });
    await createApproval(tx, { action: "BUDGET_REVISION", entityType: "BudgetRevision", entityId: rev.id, title: `${line.costCode.name} · ${project.name}: budget for ${number}`, amount: committed + amount - line.amount, projectId: project.id }, SYSTEM);
  }
  return { po, over, vendorId: q.vendorId };
}

/** After an award, tell the winner and thank the others (outside the approval transaction). */
export async function notifyAward(rfqId: string) {
  const rfq = await db.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: { material: true, quotes: true } });
  if (rfq.status !== "AWARDED") return;
  const po = rfq.poId ? await db.purchaseOrder.findUnique({ where: { id: rfq.poId } }) : null;
  for (const q of rfq.quotes) {
    const v = await db.vendor.findUnique({ where: { id: q.vendorId } });
    if (!v?.email) continue;
    const won = q.id === rfq.awardedQuoteId;
    await sendEmail(v.email, `${rfq.number}: ${won ? "order placed" : "thank you for your quote"}`,
      won ? `Dear ${v.name},\n\nWe are pleased to award enquiry ${rfq.number} (${rfq.material.name}) to you. Purchase order ${po?.number ?? ""} follows.\n\nPurchase team, Vida Estates`
          : `Dear ${v.name},\n\nThank you for quoting on ${rfq.number}. This time the order has gone to another vendor. We look forward to your next quote.\n\nPurchase team, Vida Estates`,
      { type: "Rfq", id: rfq.id }, { live: rfq.live });
  }
}

/** Remind vendors who have not quoted. */
export async function remind(rfqId: string, force = false) {
  const rfq = await db.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: { invites: true, material: true } });
  let sent = 0;
  for (const inv of rfq.invites.filter((i) => i.status === "SENT" || i.status === "OPENED")) {
    if (inv.remindedAt && !force) continue;
    const v = await db.vendor.findUnique({ where: { id: inv.vendorId } });
    if (!v) continue;
    const text = `Reminder: enquiry ${rfq.number} for ${rfq.material.name} closes on ${date(rfq.quoteDueAt)}. Quote here: ${publicUrl(`/rfq/${inv.token}`)}`;
    if (v.email) await sendEmail(v.email, `Reminder: ${rfq.number} closes ${date(rfq.quoteDueAt)}`, text, { type: "RfqInvite", id: inv.id }, { live: rfq.live });
    if (v.phone) await queueWhatsApp(v.phone, text, { type: "RfqInvite", id: inv.id });
    await db.rfqInvite.update({ where: { id: inv.id }, data: { remindedAt: new Date() } });
    sent++;
  }
  return sent;
}

// ───────────── the engine ─────────────

export type RunResult = { at: Date; sent: number; reminded: number; ready: number; extended: number };

/** One pass of the engine: send due enquiries, remind slow vendors, close quotes and build comparisons. */
export async function runEngine(actor: { id: string; name: string } = SYSTEM): Promise<RunResult> {
  const res: RunResult = { at: new Date(), sent: 0, reminded: 0, ready: 0, extended: 0 };
  // 1. Send enquiries that are due.
  for (const row of await procurementPlan("ALL")) {
    if (row.state === "DUE") { await createRfq(row.reqId, actor); res.sent++; }
  }
  // 2. Remind one day before quotes close; 3. close and compare.
  const open = await db.rfq.findMany({ where: { status: "SENT" } });
  for (const r of open) {
    if (Date.now() > r.quoteDueAt.getTime() - DAY) res.reminded += await remind(r.id);
    const out = await evaluateRfq(r.id);
    if (out === "READY") res.ready++;
    if (out === "EXTENDED") res.extended++;
  }
  await db.setting.upsert({ where: { key: "procurement.lastRun" }, create: { key: "procurement.lastRun", value: JSON.stringify(res) }, update: { value: JSON.stringify(res) } });
  return res;
}

/** Run the engine if it has not run in the last few minutes (used when the screens open). */
export async function runEngineIfStale() {
  const s = await db.setting.findUnique({ where: { key: "procurement.lastRun" } });
  const last = s ? new Date(JSON.parse(s.value).at).getTime() : 0;
  if (Date.now() - last < AUTO_RUN_MINUTES * 60000) return null;
  return runEngine();
}

export async function lastRun(): Promise<RunResult | null> {
  const s = await db.setting.findUnique({ where: { key: "procurement.lastRun" } });
  return s ? { ...JSON.parse(s.value), at: new Date(JSON.parse(s.value).at) } : null;
}

/** A one-off enquiry, outside the buying plan: chosen material, quantity, date and suppliers. */
export async function createAdhocRfq(input: { projectId: string; materialId: string; qty: number; needOnSite: Date; vendorIds: string[]; live: boolean; note?: string }, actor: { id: string; name: string }) {
  const mat = await db.material.findUniqueOrThrow({ where: { id: input.materialId } });
  const project = await db.project.findUniqueOrThrow({ where: { id: input.projectId } });
  const now = Date.now();
  const orderBy = new Date(Math.max(now + 2 * DAY, input.needOnSite.getTime() - mat.leadTimeDays * DAY));
  const due = Math.max(now + 2 * DAY, Math.min(now + mat.quoteDays * DAY, input.needOnSite.getTime() - (mat.leadTimeDays + APPROVAL_DAYS) * DAY));
  const n = (await db.rfq.count({ where: { projectId: project.id } })) + 1;
  const rfq = await db.rfq.create({
    data: {
      number: docNo("RFQ", project.code, n), projectId: project.id, materialId: mat.id, qty: input.qty, unit: mat.unit,
      needOnSite: input.needOnSite, orderBy, quoteDueAt: new Date(due), createdById: actor.id, live: input.live, note: input.note || null,
    },
  });
  const count = await inviteVendors(rfq.id, input.vendorIds);
  await audit(actor, "CREATE", "Rfq", rfq.id, `Sent ${input.live ? "LIVE " : ""}enquiry ${rfq.number} for ${input.qty} ${mat.unit} ${mat.name} to ${count} supplier(s)`);
  return rfq;
}
