"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { createApproval } from "@/lib/approvals";
import { MATCH_TOLERANCE_PCT } from "@/lib/constants";
import { docNo, inr } from "@/lib/format";
import { createPurchaseOrder, poQuantities, saveImages, imageFiles, str, numVal, fail, done } from "@/lib/cost";

// Who may do what. Requesters are kept out of the approval chain they trigger,
// because the approval engine never lets someone approve their own request.
const REVISION_ROLES = ["PROJECT_MANAGER", "PURCHASE", "ACCOUNTS"];
const MR_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "STOREKEEPER"];
const MR_APPROVERS = ["PROJECT_MANAGER", "GM_PROJECTS"];
const PURCHASE_ROLES = ["PURCHASE"];
const STORE_ROLES = ["STOREKEEPER", "SITE_ENGINEER", "PROJECT_MANAGER"];
const BILL_ROLES = ["ACCOUNTS", "FINANCE_HEAD"];

// ── Budgets ──

export async function requestRevision(fd: FormData) {
  const user = await requireUser(REVISION_ROLES);
  const lineId = str(fd, "lineId");
  const back = str(fd, "back") || "/cost/budgets";
  const newAmount = Math.round(numVal(fd, "newAmount"));
  const reason = str(fd, "reason");
  const line = await db.budgetLine.findUnique({ where: { id: lineId }, include: { costCode: true, project: true, revisions: { where: { status: "PENDING" } } } });
  if (!line || !canSeeProject(user, line.projectId)) fail(back, "Budget line not found.");
  if (!Number.isFinite(newAmount) || newAmount <= line.amount) fail(back, `The new budget must be more than the current ${inr(line.amount, { exact: true })}.`);
  if (!reason) fail(back, "Give a reason for the revision.");
  if (line.revisions.length) fail(back, "A revision for this line is already waiting for approval.");
  await db.$transaction(async (tx) => {
    const rev = await tx.budgetRevision.create({ data: { budgetLineId: line.id, oldAmount: line.amount, newAmount, reason, requestedById: user.id } });
    await audit(user, "CREATE", "BudgetRevision", rev.id, `Requested budget revision for ${line.costCode.name} · ${line.project.name}: ${inr(line.amount)} to ${inr(newAmount)}`, { before: { amount: line.amount }, after: { amount: newAmount } }, tx);
    await createApproval(tx, { action: "BUDGET_REVISION", entityType: "BudgetRevision", entityId: rev.id, title: `${line.costCode.name} · ${line.project.name}: ${inr(line.amount)} to ${inr(newAmount)}`, amount: newAmount - line.amount, projectId: line.projectId }, user);
  });
  revalidatePath("/cost/budgets");
  done(back, "Budget revision sent for approval.");
}

// ── Material requests ──

export async function createRequest(fd: FormData) {
  const user = await requireUser(MR_ROLES);
  const projectId = str(fd, "projectId");
  const qty = numVal(fd, "qty");
  const neededBy = new Date(str(fd, "neededBy"));
  if (!canSeeProject(user, projectId)) fail("/cost/requests", "Choose one of your projects.");
  if (!str(fd, "item") || !str(fd, "unit")) fail("/cost/requests", "Item and unit are required.");
  if (!Number.isFinite(qty) || qty <= 0) fail("/cost/requests", "Quantity must be more than zero.");
  if (Number.isNaN(neededBy.getTime())) fail("/cost/requests", "Pick the date the material is needed by.");
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const n = (await db.materialRequest.count({ where: { projectId } })) + 1;
  const mr = await db.materialRequest.create({
    data: { number: docNo("MR", project.code, n), projectId, costCodeId: str(fd, "costCodeId"), item: str(fd, "item"), qty, unit: str(fd, "unit"), neededBy, note: str(fd, "note") || null, requestedById: user.id },
  });
  await audit(user, "CREATE", "MaterialRequest", mr.id, `Raised ${mr.number}: ${mr.qty} ${mr.unit} ${mr.item}`, { after: mr });
  revalidatePath("/cost/requests");
  done("/cost/requests", `${mr.number} raised.`);
}

export async function decideRequest(fd: FormData) {
  const user = await requireUser(MR_APPROVERS);
  const id = str(fd, "id");
  const decision = str(fd, "decision") === "APPROVED" ? "APPROVED" : "REJECTED";
  const back = str(fd, "back") || "/cost/requests";
  const mr = await db.materialRequest.findUnique({ where: { id } });
  if (!mr || !canSeeProject(user, mr.projectId)) fail(back, "Request not found.");
  if (mr.status !== "SUBMITTED") fail(back, "This request has already been decided.");
  if (mr.requestedById === user.id) fail(back, "You raised this request, so someone else must approve it.");
  await db.materialRequest.update({ where: { id }, data: { status: decision } });
  await audit(user, decision === "APPROVED" ? "APPROVE" : "REJECT", "MaterialRequest", id, `${decision === "APPROVED" ? "Approved" : "Rejected"} ${mr.number}`);
  revalidatePath("/cost/requests");
  done(back, `${mr.number} ${decision === "APPROVED" ? "approved. Purchase can now collect quotes." : "rejected."}`);
}

export async function addQuote(fd: FormData) {
  const user = await requireUser(PURCHASE_ROLES);
  const requestId = str(fd, "requestId");
  const back = `/cost/requests/${requestId}`;
  const mr = await db.materialRequest.findUnique({ where: { id: requestId }, include: { quotes: true } });
  if (!mr || !canSeeProject(user, mr.projectId)) fail("/cost/requests", "Request not found.");
  if (mr.status !== "APPROVED") fail(back, "Quotes can only be added to approved requests.");
  const vendorId = str(fd, "vendorId");
  const rate = numVal(fd, "rate");
  const gstPct = numVal(fd, "gstPct");
  const deliveryDays = numVal(fd, "deliveryDays");
  if (mr.quotes.some((q) => q.vendorId === vendorId)) fail(back, "This vendor has already quoted.");
  if (!(rate > 0) || !(gstPct >= 0) || !(deliveryDays >= 0)) fail(back, "Enter the rate, GST % and delivery days as numbers.");
  const q = await db.quote.create({ data: { requestId, vendorId, rate, gstPct, deliveryDays: Math.round(deliveryDays) } });
  await audit(user, "CREATE", "Quote", q.id, `Added quote for ${mr.number} at ₹${rate}/${mr.unit}`);
  revalidatePath(back);
  done(back, "Quote added.");
}

export async function createPoFromQuote(fd: FormData) {
  const user = await requireUser(PURCHASE_ROLES);
  const requestId = str(fd, "requestId");
  const back = `/cost/requests/${requestId}`;
  const mr = await db.materialRequest.findUnique({ where: { id: requestId }, include: { quotes: true } });
  if (!mr || !canSeeProject(user, mr.projectId)) fail("/cost/requests", "Request not found.");
  if (mr.status !== "APPROVED") fail(back, "Only approved requests can be ordered.");
  if (mr.quotes.length < 3) fail(back, "Collect at least 3 quotes before creating a PO.");
  const quote = mr.quotes.find((q) => q.id === str(fd, "quoteId"));
  if (!quote) fail(back, "Choose a quote.");
  await db.quote.updateMany({ where: { requestId }, data: { selected: false } });
  await db.quote.update({ where: { id: quote.id }, data: { selected: true } });
  const { po, overBudget } = await createPurchaseOrder({
    requestId, projectId: mr.projectId, costCodeId: mr.costCodeId, vendorId: quote.vendorId,
    item: mr.item, qty: mr.qty, unit: mr.unit, rate: quote.rate, gstPct: quote.gstPct,
  }, user);
  revalidatePath("/cost/orders");
  revalidatePath("/cost/requests");
  done(`/cost/orders/${po.id}`, overBudget
    ? `${po.number} is over the remaining budget, so it is on hold until a budget revision is approved.`
    : `${po.number} created and sent for approval.`);
}

// ── Goods received ──

export async function receiveGoods(fd: FormData): Promise<{ error?: string; redirectTo?: string }> {
  const user = await requireUser(STORE_ROLES);
  const po = await db.purchaseOrder.findUnique({ where: { id: str(fd, "poId") }, include: { project: true } });
  if (!po || !canSeeProject(user, po.projectId)) return { error: "Choose a purchase order." };
  if (!["APPROVED", "PARTLY_RECEIVED"].includes(po.status)) return { error: "Goods can only be received against an approved PO." };
  const qty = numVal(fd, "qty");
  const challanNo = str(fd, "challanNo");
  if (!(qty > 0)) return { error: "Quantity received must be more than zero." };
  if (!challanNo) return { error: "Enter the delivery challan number." };
  const { received } = await poQuantities(po.id);
  const remaining = po.qty - received;
  if (qty > remaining + 1e-9) return { error: `Only ${remaining} ${po.unit} is still due on ${po.number}. Do not accept more than the PO quantity.` };

  let photo: string | null = null;
  const files = imageFiles(fd, "challanPhoto");
  if (files.length) {
    try { photo = (await saveImages(files.slice(0, 1), "grn"))[0].path; } catch (e) { return { error: (e as Error).message }; }
  }

  await db.$transaction(async (tx) => {
    const n = (await tx.goodsReceipt.count({ where: { po: { projectId: po.projectId } } })) + 1;
    const g = await tx.goodsReceipt.create({ data: { number: docNo("GRN", po.project.code, n), poId: po.id, qty, challanNo, photo, note: str(fd, "note") || null, receivedById: user.id } });
    await tx.stockMove.create({ data: { projectId: po.projectId, item: po.item, unit: po.unit, qty, type: "RECEIPT", reference: g.number, userId: user.id } });
    const status = received + qty >= po.qty - 1e-9 ? "RECEIVED" : "PARTLY_RECEIVED";
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status } });
    await audit(user, "CREATE", "GoodsReceipt", g.id, `${g.number}: received ${qty} ${po.unit} against ${po.number} (challan ${challanNo})`, undefined, tx);
  });
  revalidatePath("/cost/receipts");
  revalidatePath("/cost/stock");
  revalidatePath(`/cost/orders/${po.id}`);
  return { redirectTo: `/cost/receipts?ok=${encodeURIComponent(`Received ${qty} ${po.unit} against ${po.number}.`)}` };
}

// ── Stock ──

export async function issueStock(fd: FormData) {
  const user = await requireUser(STORE_ROLES);
  const [projectId, item, unit] = str(fd, "key").split("|");
  const back = `/cost/stock?project=${projectId}`;
  const qty = numVal(fd, "qty");
  if (!canSeeProject(user, projectId)) fail("/cost/stock", "Choose one of your projects.");
  if (!(qty > 0)) fail(back, "Quantity must be more than zero.");
  const bal = await db.stockMove.aggregate({ where: { projectId, item, unit }, _sum: { qty: true } });
  const onHand = bal._sum.qty ?? 0;
  if (qty > onHand + 1e-9) fail(back, `Only ${onHand} ${unit} of ${item} is in stock.`);
  const m = await db.stockMove.create({ data: { projectId, item, unit, qty: -qty, type: "ISSUE", reference: str(fd, "reference") || "Issued to site", userId: user.id } });
  await audit(user, "CREATE", "StockMove", m.id, `Issued ${qty} ${unit} of ${item} to site`);
  revalidatePath("/cost/stock");
  done(back, `Issued ${qty} ${unit} of ${item}.`);
}

// ── Vendor bills ──

export async function enterBill(fd: FormData) {
  const user = await requireUser(BILL_ROLES);
  const po = await db.purchaseOrder.findUnique({ where: { id: str(fd, "poId") } });
  if (!po || !canSeeProject(user, po.projectId)) fail("/cost/bills", "Choose a purchase order.");
  const qty = numVal(fd, "qty");
  const rate = numVal(fd, "rate");
  const tdsPct = str(fd, "tdsPct") ? numVal(fd, "tdsPct") : 1;
  const billDate = new Date(str(fd, "billDate"));
  const billNo = str(fd, "billNo");
  if (!billNo || Number.isNaN(billDate.getTime())) fail("/cost/bills", "Bill number and date are required.");
  if (!(qty > 0) || !(rate > 0) || !(tdsPct >= 0)) fail("/cost/bills", "Enter quantity, rate and TDS % as numbers.");

  const { received, billed } = await poQuantities(po.id);
  const billable = received - billed;
  const rateDiff = ((rate - po.rate) / po.rate) * 100;
  const notes: string[] = [];
  if (qty > billable + 1e-9) notes.push(`Billed ${qty} ${po.unit} but only ${Math.max(0, billable)} ${po.unit} has been received and not yet billed`);
  if (Math.abs(rateDiff) > MATCH_TOLERANCE_PCT) notes.push(`Billed rate ₹${rate} is ${rateDiff > 0 ? "above" : "below"} the PO rate ₹${po.rate} by ${Math.abs(rateDiff).toFixed(1)}%`);
  const match = notes.length ? "MISMATCH" : "MATCHED";

  const bill = await db.vendorBill.create({
    data: {
      poId: po.id, vendorId: po.vendorId, billNo, billDate, qty, rate, tdsPct,
      amount: Math.round(qty * rate * (1 + po.gstPct / 100)), match, matchNote: notes.join(". ") || null,
      status: match === "MATCHED" ? "ENTERED" : "ON_HOLD", enteredById: user.id,
    },
  });
  await audit(user, "CREATE", "VendorBill", bill.id, `Entered bill ${billNo} against ${po.number}: ${match === "MATCHED" ? "matched PO and goods received" : "on hold, " + bill.matchNote}`, { after: bill });
  revalidatePath("/cost/bills");
  if (match === "MATCHED") done("/cost/bills", `Bill ${billNo} matches the PO and goods received.`);
  fail("/cost/bills", `Bill ${billNo} is on hold: ${bill.matchNote}.`);
}

export async function billAction(fd: FormData) {
  const op = str(fd, "op");
  const user = await requireUser(op === "send" ? ["ACCOUNTS"] : ["FINANCE_HEAD"]);
  const bill = await db.vendorBill.findUnique({ where: { id: str(fd, "id") }, include: { po: true, vendor: true } });
  if (!bill || !canSeeProject(user, bill.po.projectId)) fail("/cost/bills", "Bill not found.");

  if (op === "resolve") {
    const comment = str(fd, "comment");
    if (bill.status !== "ON_HOLD") fail("/cost/bills", "Only bills on hold can be resolved.");
    if (!comment) fail("/cost/bills", "Write why this mismatch is acceptable before accepting it.");
    await db.vendorBill.update({ where: { id: bill.id }, data: { status: "PAYABLE" } });
    await audit(user, "APPROVE", "VendorBill", bill.id, `Resolved mismatch on bill ${bill.billNo} and marked payable: ${comment}`, { before: { status: "ON_HOLD" }, after: { status: "PAYABLE" } });
    done("/cost/bills", `Bill ${bill.billNo} is now payable.`);
  }
  if (op === "payable") {
    if (bill.status !== "ENTERED" || bill.match !== "MATCHED") fail("/cost/bills", "Only matched bills can be marked payable.");
    await db.vendorBill.update({ where: { id: bill.id }, data: { status: "PAYABLE" } });
    await audit(user, "APPROVE", "VendorBill", bill.id, `Marked bill ${bill.billNo} payable`);
    revalidatePath("/cost/bills");
    done("/cost/bills", `Bill ${bill.billNo} is now payable.`);
  }
  if (op === "send") {
    if (bill.status !== "PAYABLE") fail("/cost/bills", "Only payable bills can be sent for payment.");
    const tds = Math.round((bill.qty * bill.rate * bill.tdsPct) / 100);
    const net = bill.amount - tds;
    await db.$transaction(async (tx) => {
      await tx.vendorBill.update({ where: { id: bill.id }, data: { status: "IN_PAYMENT" } });
      await audit(user, "UPDATE", "VendorBill", bill.id, `Sent bill ${bill.billNo} for payment (net ${inr(net, { exact: true })} after TDS)`, undefined, tx);
      await createApproval(tx, { action: "VENDOR_PAYMENT", entityType: "VendorBill", entityId: bill.id, title: `Pay ${bill.vendor.name}, bill ${bill.billNo} (${bill.po.number})`, amount: net, projectId: bill.po.projectId }, user);
    });
    revalidatePath("/cost/bills");
    done("/cost/bills", `Bill ${bill.billNo} sent for payment approval.`);
  }
  fail("/cost/bills", "Unknown action.");
}
