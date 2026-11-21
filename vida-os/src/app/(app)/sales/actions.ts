"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject, type CurrentUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { createApproval } from "@/lib/approvals";
import { raiseBookingDemands, refreshDemand } from "@/lib/collections";
import { intakeLead, releaseIfExpired, effectiveStatus } from "@/lib/sales";
import { BLOCK_HOURS, LEAD_STAGES, SALES_INCENTIVE_PCT, SALES_MANAGERS, SALES_ROLES, COLLECTION_ROLES } from "@/lib/constants";
import { docNo, normPhone } from "@/lib/format";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const n = (f: FormData, k: string) => Number(String(f.get(k) ?? "").replace(/[^\d.]/g, "")) || 0;

function back(f: FormData, fallback: string) {
  const b = s(f, "back");
  return b.startsWith("/") ? b : fallback;
}
function withParam(path: string, key: string, value: string) {
  const [p, q] = path.split("?");
  const sp = new URLSearchParams(q);
  sp.delete("error");
  sp.delete("ok");
  sp.set(key, value);
  return `${p}?${sp.toString()}`;
}
function fail(path: string, msg: string): never {
  redirect(withParam(path, "error", msg));
}
function done(path: string, msg: string): never {
  redirect(withParam(path, "ok", msg));
}

/** Executives may only touch their own leads; managers their projects' leads. */
async function loadLead(u: CurrentUser, id: string) {
  const lead = await db.lead.findUnique({ where: { id } });
  if (!lead) return null;
  if (u.role === "SALES_EXEC" && lead.ownerId !== u.id) return null;
  if (u.role !== "SALES_EXEC" && !canSeeProject(u, lead.projectId) && u.projectIds !== "ALL") return null;
  return lead;
}

// ───────── Leads ─────────

export async function quickAddLead(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const path = back(f, "/sales/leads");
  const source = s(f, "source") || "WALK_IN";
  if (source === "CHANNEL_PARTNER" && !s(f, "channelPartnerId")) fail(path, "Pick the channel partner who sent this lead");
  let res;
  try {
    res = await intakeLead(
      {
        name: s(f, "name"),
        phone: s(f, "phone"),
        email: s(f, "email") || null,
        projectId: s(f, "projectId") || null,
        source,
        channelPartnerId: source === "CHANNEL_PARTNER" ? s(f, "channelPartnerId") : null,
        preferredType: s(f, "preferredType") || null,
        notes: s(f, "note") || null,
      },
      u,
    );
  } catch (e) {
    fail(path, (e as Error).message);
  }
  revalidatePath("/sales");
  if (res.duplicate) done(path, `${res.lead.name} is already a lead. We added this enquiry to their record.`);
  redirect(`/sales/leads/${res.lead.id}?ok=${encodeURIComponent("Lead saved and assigned")}`);
}

/** Portal CSV: header row with name, phone, email, project (code or name, optional). */
export async function importCsv(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const path = "/sales/leads";
  const source = s(f, "source");
  if (!["99ACRES", "MAGICBRICKS", "HOUSING"].includes(source)) fail(path, "Pick which portal the file came from");
  let text = s(f, "csv");
  const file = f.get("file");
  if (file && typeof file === "object" && "text" in file && (file as File).size > 0) text = await (file as File).text();
  if (!text) fail(path, "Paste the CSV or choose a file");

  const rows = parseCsv(text);
  if (rows.length < 2) fail(path, "The file needs a header row and at least one lead");
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const col = (names: string[]) => header.findIndex((h) => names.some((x) => h.includes(x)));
  const iName = col(["name"]), iPhone = col(["phone", "mobile"]), iEmail = col(["email"]), iProject = col(["project"]);
  if (iName < 0 || iPhone < 0) fail(path, "The header must include name and phone columns");

  const projects = await db.project.findMany();
  const defaultProject = s(f, "projectId") || null;
  let imported = 0, dups = 0, bad = 0;
  for (const r of rows.slice(1)) {
    if (r.every((c) => !c.trim())) continue;
    const pv = iProject >= 0 ? (r[iProject] || "").trim().toLowerCase() : "";
    const proj = pv ? projects.find((p) => p.code.toLowerCase() === pv || p.name.toLowerCase() === pv) : null;
    try {
      const res = await intakeLead({ name: r[iName] || "", phone: r[iPhone] || "", email: iEmail >= 0 ? r[iEmail] : null, projectId: proj?.id ?? defaultProject, source }, u);
      if (res.duplicate) dups++; else imported++;
    } catch {
      bad++;
    }
  }
  await audit(u, "CREATE", "LeadImport", null, `Imported ${imported} lead(s) from ${source} CSV (${dups} duplicate, ${bad} skipped)`);
  revalidatePath("/sales");
  done(path, `Imported ${imported} new lead(s). ${dups} already existed and were attached. ${bad} row(s) skipped.`);
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); out.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

export async function logActivity(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const id = s(f, "leadId");
  const path = back(f, `/sales/leads/${id}`);
  const lead = await loadLead(u, id);
  if (!lead) fail(path, "Lead not found");
  const type = s(f, "type");
  if (!["CALL", "WHATSAPP", "NOTE"].includes(type)) fail(path, "Pick what you did");
  const note = s(f, "note");
  const followUp = s(f, "nextFollowUp");
  await db.$transaction(async (tx) => {
    await tx.activity.create({ data: { leadId: id, userId: u.id, type, note: note || null } });
    const data: Record<string, unknown> = { lastActivityAt: new Date() };
    if (type === "CALL" && !lead.firstCallAt) data.firstCallAt = new Date();
    if (type === "CALL" && lead.stage === "NEW") data.stage = "CONTACTED";
    if (followUp) data.nextFollowUp = new Date(followUp + ":00+05:30");
    await tx.lead.update({ where: { id }, data });
    await audit(u, "UPDATE", "Lead", id, `Logged ${type.toLowerCase()} for ${lead.name}${note ? `: ${note}` : ""}`, undefined, tx);
  });
  revalidatePath("/sales");
  done(path, "Saved");
}

export async function scheduleVisit(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const id = s(f, "leadId");
  const path = back(f, `/sales/leads/${id}`);
  const lead = await loadLead(u, id);
  if (!lead) fail(path, "Lead not found");
  const when = s(f, "when");
  if (!when) fail(path, "Pick the visit date and time");
  const at = new Date(when + ":00+05:30");
  await db.$transaction(async (tx) => {
    await tx.activity.create({ data: { leadId: id, userId: u.id, type: "SITE_VISIT", note: s(f, "note") || "Site visit scheduled", scheduledFor: at } });
    await tx.lead.update({
      where: { id },
      data: { stage: ["NEW", "CONTACTED"].includes(lead.stage) ? "VISIT_SCHEDULED" : lead.stage, nextFollowUp: at, lastActivityAt: new Date(), firstCallAt: lead.firstCallAt ?? new Date() },
    });
    await audit(u, "UPDATE", "Lead", id, `Site visit scheduled for ${lead.name}`, { after: { scheduledFor: at } }, tx);
  });
  revalidatePath("/sales");
  done(path, "Site visit scheduled. Send the WhatsApp confirmation below.");
}

export async function changeStage(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const id = s(f, "leadId");
  const path = back(f, `/sales/leads/${id}`);
  const lead = await loadLead(u, id);
  if (!lead) fail(path, "Lead not found");
  const stage = s(f, "stage");
  if (!LEAD_STAGES.some((x) => x.key === stage)) fail(path, "Unknown stage");
  if (["BOOKED", "UNIT_BLOCKED"].includes(stage)) fail(path, "Block or book a unit from the inventory to move to this stage");
  const lostReason = s(f, "lostReason");
  if (stage === "LOST" && !lostReason) fail(path, "Give a reason before marking the lead lost");
  await db.$transaction(async (tx) => {
    await tx.lead.update({ where: { id }, data: { stage, lostReason: stage === "LOST" ? lostReason : null, lastActivityAt: new Date() } });
    await tx.activity.create({ data: { leadId: id, userId: u.id, type: "STAGE", note: `Moved to ${LEAD_STAGES.find((x) => x.key === stage)?.label}${stage === "LOST" ? ` (${lostReason})` : ""}` } });
    await audit(u, "UPDATE", "Lead", id, `Stage of ${lead.name} changed`, { before: { stage: lead.stage }, after: { stage, lostReason: lostReason || undefined } }, tx);
  });
  revalidatePath("/sales");
  done(path, "Stage updated");
}

export async function reassignLead(f: FormData) {
  const u = await requireUser(SALES_MANAGERS);
  const id = s(f, "leadId");
  const path = back(f, `/sales/leads/${id}`);
  const lead = await loadLead(u, id);
  if (!lead) fail(path, "Lead not found");
  const ownerId = s(f, "ownerId");
  const owner = await db.user.findUnique({ where: { id: ownerId } });
  if (!owner || !["SALES_EXEC", "SALES_MANAGER", "SALES_HEAD"].includes(owner.role)) fail(path, "Pick a sales team member");
  await db.$transaction(async (tx) => {
    await tx.lead.update({ where: { id }, data: { ownerId } });
    await tx.activity.create({ data: { leadId: id, userId: u.id, type: "SYSTEM", note: `Reassigned to ${owner.name}` } });
    await audit(u, "UPDATE", "Lead", id, `Lead ${lead.name} reassigned to ${owner.name}`, { before: { ownerId: lead.ownerId }, after: { ownerId } }, tx);
  });
  revalidatePath("/sales");
  done(path, `Reassigned to ${owner.name}`);
}

// ───────── Inventory ─────────

const SELLERS = SALES_ROLES.filter((r) => r !== "MARKETING");

/** RERA: no blocking or booking until the project has its TS RERA registration number. */
const RERA_MSG = "This project is awaiting TS RERA registration. Units can be blocked and booked only after registration; register the buyer's interest as a lead for now.";

export async function blockUnit(f: FormData) {
  const u = await requireUser(SELLERS);
  const unitId = s(f, "unitId");
  const leadId = s(f, "leadId");
  const path = back(f, "/sales/inventory");
  if (!leadId) fail(path, "Pick the buyer (lead) this unit is blocked for");
  const lead = await loadLead(u, leadId);
  if (!lead) fail(path, "Lead not found");
  try {
    await db.$transaction(async (tx) => {
      const unit = await releaseIfExpired(tx, unitId);
      if (unit.status !== "AVAILABLE") throw new Error(`Unit ${unit.number} is not available`);
      if (!(await tx.project.findUniqueOrThrow({ where: { id: unit.projectId } })).reraNo) throw new Error(RERA_MSG);
      if (lead.projectId && unit.projectId !== lead.projectId) throw new Error("This unit is in a different project from the lead");
      // conditional update so two people can never block the same unit
      const r = await tx.unit.updateMany({
        where: { id: unitId, status: "AVAILABLE" },
        data: { status: "BLOCKED", blockedById: u.id, blockedLeadId: leadId, blockedUntil: new Date(Date.now() + BLOCK_HOURS * 3600000) },
      });
      if (r.count !== 1) throw new Error("Someone else just blocked this unit");
      await tx.lead.update({ where: { id: leadId }, data: { stage: "UNIT_BLOCKED", projectId: unit.projectId, lastActivityAt: new Date() } });
      await tx.activity.create({ data: { leadId, userId: u.id, type: "STAGE", note: `Blocked unit ${unit.number} for ${BLOCK_HOURS} hours` } });
      await audit(u, "UPDATE", "Unit", unitId, `Blocked ${unit.number} for ${lead.name}`, { before: { status: "AVAILABLE" }, after: { status: "BLOCKED", leadId } }, tx);
    });
  } catch (e) {
    fail(path, (e as Error).message);
  }
  revalidatePath("/sales");
  done(path, `Unit blocked for ${BLOCK_HOURS} hours`);
}

export async function extendBlock(f: FormData) {
  const u = await requireUser(SALES_MANAGERS);
  const unitId = s(f, "unitId");
  const path = back(f, "/sales/inventory");
  const unit = await db.unit.findUnique({ where: { id: unitId } });
  if (!unit || effectiveStatus(unit) !== "BLOCKED") fail(path, "This unit is not blocked");
  const until = new Date((unit.blockedUntil?.getTime() ?? Date.now()) + 24 * 3600000);
  await db.unit.update({ where: { id: unitId }, data: { blockedUntil: until } });
  await audit(u, "UPDATE", "Unit", unitId, `Extended block on ${unit.number} by 24 hours`, { before: { blockedUntil: unit.blockedUntil }, after: { blockedUntil: until } });
  revalidatePath("/sales");
  done(path, "Block extended by 24 hours");
}

export async function releaseBlock(f: FormData) {
  const u = await requireUser(SALES_ROLES);
  const unitId = s(f, "unitId");
  const path = back(f, "/sales/inventory");
  const unit = await db.unit.findUnique({ where: { id: unitId } });
  if (!unit || unit.status !== "BLOCKED") fail(path, "This unit is not blocked");
  if (unit.blockedById !== u.id && !SALES_MANAGERS.includes(u.role)) fail(path, "Only the person who blocked it or a manager can release it");
  await db.$transaction(async (tx) => {
    await tx.unit.update({ where: { id: unitId }, data: { status: "AVAILABLE", blockedById: null, blockedLeadId: null, blockedUntil: null } });
    if (unit.blockedLeadId) {
      const lead = await tx.lead.findUnique({ where: { id: unit.blockedLeadId } });
      if (lead?.stage === "UNIT_BLOCKED") await tx.lead.update({ where: { id: lead.id }, data: { stage: "NEGOTIATION" } });
    }
    await audit(u, "UPDATE", "Unit", unitId, `Released block on ${unit.number}`, { before: { status: "BLOCKED" }, after: { status: "AVAILABLE" } }, tx);
  });
  revalidatePath("/sales");
  done(path, "Unit released");
}

export async function bookUnit(f: FormData) {
  const u = await requireUser(SELLERS);
  const unitId = s(f, "unitId");
  const path = back(f, `/sales/inventory/${unitId}`);
  const buyerName = s(f, "buyerName");
  const buyerPhone = normPhone(s(f, "buyerPhone"));
  const planId = s(f, "planId");
  const agreementValue = Math.round(n(f, "agreementValue"));
  const tokenAmount = Math.round(n(f, "tokenAmount"));
  const paymentRef = s(f, "paymentRef");
  if (!buyerName || buyerPhone.length !== 10) fail(path, "Enter the buyer's name and a 10-digit mobile number");
  if (!planId) fail(path, "Pick a payment plan");
  if (agreementValue <= 0 || tokenAmount <= 0) fail(path, "Enter the agreement value and token amount");
  if (!paymentRef) fail(path, "Enter the token payment reference (UTR or cheque number)");

  let bookingId = "";
  let discountNote = "";
  try {
    await db.$transaction(async (tx) => {
      const unit = await releaseIfExpired(tx, unitId);
      if (unit.status !== "BLOCKED") throw new Error("Block the unit for this buyer before booking it");
      if (!(await tx.project.findUniqueOrThrow({ where: { id: unit.projectId } })).reraNo) throw new Error(RERA_MSG);
      if (unit.blockedById !== u.id && !SALES_MANAGERS.includes(u.role)) throw new Error("Only the person who blocked this unit or a manager can book it");
      if (!unit.blockedLeadId) throw new Error("This block has no lead attached");
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: unit.blockedLeadId }, include: { channelPartner: true } });
      const plan = await tx.paymentPlan.findUniqueOrThrow({ where: { id: planId } });
      if (plan.projectId !== unit.projectId) throw new Error("That payment plan belongs to another project");
      const project = await tx.project.findUniqueOrThrow({ where: { id: unit.projectId } });

      const r = await tx.unit.updateMany({ where: { id: unitId, status: "BLOCKED" }, data: { status: "BOOKED", blockedById: null, blockedLeadId: null, blockedUntil: null } });
      if (r.count !== 1) throw new Error("This unit was just changed by someone else");

      const booking = await tx.booking.create({
        data: { unitId, leadId: lead.id, planId, buyerName, buyerPhone, buyerEmail: s(f, "buyerEmail") || null, agreementValue, tokenAmount, paymentRef, bookedById: u.id },
      });
      bookingId = booking.id;
      await tx.lead.update({ where: { id: lead.id }, data: { stage: "BOOKED", lastActivityAt: new Date() } });
      await tx.activity.create({ data: { leadId: lead.id, userId: u.id, type: "STAGE", note: `Booked unit ${unit.number}, token ₹${tokenAmount.toLocaleString("en-IN")} (${paymentRef})` } });
      await raiseBookingDemands(tx, booking.id);

      if (lead.channelPartner) {
        const cp = lead.channelPartner;
        await tx.payout.create({
          data: { bookingId: booking.id, type: "CP_COMMISSION", payeeName: `${cp.name}${cp.firm ? ` (${cp.firm})` : ""}`, channelPartnerId: cp.id, ratePct: cp.commissionPct, amount: Math.round((agreementValue * cp.commissionPct) / 100) },
        });
      }
      const owner = lead.ownerId ? await tx.user.findUnique({ where: { id: lead.ownerId } }) : null;
      if (owner) {
        await tx.payout.create({
          data: { bookingId: booking.id, type: "SALES_INCENTIVE", payeeName: owner.name, userId: owner.id, ratePct: SALES_INCENTIVE_PCT, amount: Math.round((agreementValue * SALES_INCENTIVE_PCT) / 100) },
        });
      }

      const expected = plan.type === "DOWN_PAYMENT" ? Math.round(unit.price * 0.97) : unit.price;
      const discount = expected - agreementValue;
      if (discount > 0) {
        await createApproval(tx, {
          action: "DISCOUNT", entityType: "Booking", entityId: booking.id,
          title: `Discount on ${unit.number} for ${buyerName}`, amount: discount, projectId: unit.projectId,
        }, u);
        discountNote = " The discount is awaiting approval.";
      }
      await audit(u, "CREATE", "Booking", booking.id, `Booked ${unit.number} (${project.name}) for ${buyerName}`, { after: { agreementValue, tokenAmount, planId } }, tx);
    });
  } catch (e) {
    fail(path, (e as Error).message);
  }
  revalidatePath("/sales");
  redirect(`/sales/bookings/${bookingId}?ok=${encodeURIComponent("Booking recorded. Demand letters raised for amounts due on booking." + discountNote)}`);
}

// ───────── Collections ─────────

export async function recordReceipt(f: FormData) {
  const u = await requireUser(COLLECTION_ROLES);
  const bookingId = s(f, "bookingId");
  const path = back(f, `/sales/bookings/${bookingId}`);
  const amount = Math.round(n(f, "amount"));
  const mode = s(f, "mode");
  const reference = s(f, "reference");
  const demandId = s(f, "demandId") || null;
  if (amount <= 0) fail(path, "Enter the amount received");
  if (!["NEFT", "RTGS", "UPI", "CHEQUE"].includes(mode)) fail(path, "Pick the payment mode");
  if (!reference) fail(path, "Enter the bank reference");
  await db.$transaction(async (tx) => {
    const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { unit: { include: { project: true } } } });
    const count = await tx.receipt.count({ where: { booking: { unit: { projectId: b.unit.projectId } } } });
    const r = await tx.receipt.create({
      data: { bookingId, demandId, number: docNo("RC", b.unit.project.code, count + 1), amount, mode, reference, enteredById: u.id },
    });
    if (demandId) await refreshDemand(tx, demandId);
    await audit(u, "CREATE", "Receipt", r.id, `Receipt ${r.number} of ₹${amount.toLocaleString("en-IN")} from ${b.buyerName}`, { after: { amount, mode, reference, demandId } }, tx);
  });
  revalidatePath("/sales");
  done(path, "Receipt recorded");
}

export async function setBookingStatus(f: FormData) {
  const u = await requireUser(COLLECTION_ROLES);
  const id = s(f, "bookingId");
  const path = back(f, `/sales/bookings/${id}`);
  const status = s(f, "status");
  if (!["AGREEMENT_SIGNED", "REGISTERED"].includes(status)) fail(path, "Unknown status");
  const b = await db.booking.findUnique({ where: { id } });
  if (!b) fail(path, "Booking not found");
  await db.$transaction(async (tx) => {
    await tx.booking.update({ where: { id }, data: { status } });
    if (status === "AGREEMENT_SIGNED") await tx.lead.update({ where: { id: b.leadId }, data: { stage: "AGREEMENT_SIGNED" } });
    await audit(u, "UPDATE", "Booking", id, `Booking for ${b.buyerName} marked ${status.replace(/_/g, " ").toLowerCase()}`, { before: { status: b.status }, after: { status } }, tx);
  });
  revalidatePath("/sales");
  done(path, "Booking updated");
}

// ───────── Customer portal ─────────

/** Create (or replace) the buyer's private portal link, or turn it off. */
export async function setPortalLink(f: FormData) {
  const u = await requireUser(COLLECTION_ROLES);
  const id = s(f, "bookingId");
  const path = back(f, `/sales/bookings/${id}`);
  const turnOff = s(f, "mode") === "off";
  const b = await db.booking.findUnique({ where: { id }, include: { unit: true } });
  if (!b || !canSeeProject(u, b.unit.projectId)) fail(path, "Booking not found");
  const { randomBytes } = await import("node:crypto");
  const portalToken = turnOff ? null : randomBytes(24).toString("base64url");
  await db.booking.update({ where: { id }, data: { portalToken, ...(turnOff ? {} : { portalOpenedAt: null }) } });
  await audit(u, "UPDATE", "Booking", id, turnOff ? `Turned off the portal link for ${b.buyerName}` : b.portalToken ? `Made a new portal link for ${b.buyerName} (the old one stops working)` : `Made a portal link for ${b.buyerName}`);
  revalidatePath(path);
  done(path, turnOff ? "Portal link turned off." : "Portal link ready. Send it to the buyer on WhatsApp.");
}

// ───────── Payouts ─────────

export async function sendPayoutForApproval(f: FormData) {
  // Accounts is the maker; approvers are set in the payout approval chain.
  const u = await requireUser(["ACCOUNTS"]);
  const id = s(f, "payoutId");
  const path = back(f, "/sales/payouts");
  try {
    await db.$transaction(async (tx) => {
      const p = await tx.payout.findUniqueOrThrow({ where: { id }, include: { booking: { include: { unit: true } } } });
      if (p.status !== "PENDING") throw new Error("This payout has already been sent");
      await tx.payout.update({ where: { id }, data: { status: "IN_APPROVAL" } });
      await createApproval(tx, {
        action: "PAYOUT", entityType: "Payout", entityId: id,
        title: `${p.type === "CP_COMMISSION" ? "Partner commission" : "Sales incentive"} · ${p.payeeName} · ${p.booking.unit.number}`,
        amount: p.amount, projectId: p.booking.unit.projectId,
      }, u);
      await audit(u, "UPDATE", "Payout", id, `Sent payout to ${p.payeeName} for approval`, { before: { status: "PENDING" }, after: { status: "IN_APPROVAL" } }, tx);
    });
  } catch (e) {
    fail(path, (e as Error).message);
  }
  revalidatePath("/sales/payouts");
  done(path, "Sent for approval");
}

export async function markPayoutPaid(f: FormData) {
  const u = await requireUser(["ACCOUNTS", "FINANCE_HEAD"]);
  const id = s(f, "payoutId");
  const path = back(f, "/sales/payouts");
  const p = await db.payout.findUnique({ where: { id } });
  if (!p || p.status !== "APPROVED") fail(path, "Only approved payouts can be marked paid");
  await db.payout.update({ where: { id }, data: { status: "PAID" } });
  await audit(u, "UPDATE", "Payout", id, `Marked payout to ${p.payeeName} as paid`, { before: { status: "APPROVED" }, after: { status: "PAID" } });
  revalidatePath("/sales/payouts");
  done(path, "Marked as paid");
}
