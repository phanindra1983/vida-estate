"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { runEngine, submitAward, remind, evaluateRfq, createRfq, comparison, createAdhocRfq } from "@/lib/procurement";
import { str, numVal, fail, done } from "@/lib/cost";
import { sendEmail, emailTestTo } from "@/lib/notify";
import { checkInbox, inboxConfigured } from "@/lib/mail-inbox";

const BUYERS = ["MD", "GM_PROJECTS", "PROJECT_MANAGER", "PURCHASE"];
const SETUP = ["MD", "GM_PROJECTS", "PROJECT_MANAGER", "PURCHASE"];

export async function runNow() {
  const u = await requireUser(PROCUREMENT_ROLES);
  const r = await runEngine({ id: u.id, name: u.name });
  revalidatePath("/procurement", "layout");
  done("/procurement", `Engine ran: ${r.sent} enquiry(ies) sent, ${r.reminded} reminder(s), ${r.ready} comparison(s) ready${r.extended ? `, ${r.extended} extended` : ""}.`);
}

export async function sendNow(fd: FormData) {
  const u = await requireUser(BUYERS);
  const req = await db.materialRequirement.findUniqueOrThrow({ where: { id: str(fd, "reqId") } });
  if (!canSeeProject(u, req.projectId)) fail("/procurement", "Not your project");
  const rfq = await createRfq(req.id, { id: u.id, name: u.name });
  done(`/procurement/rfq/${rfq.id}`, `Enquiry ${rfq.number} sent early.`);
}

export async function chooseVendor(fd: FormData) {
  const u = await requireUser(BUYERS);
  const id = str(fd, "rfqId");
  const back = `/procurement/rfq/${id}`;
  const quoteId = str(fd, "quoteId");
  const reason = str(fd, "reason");
  const { recommended } = await comparison(id);
  if (recommended && quoteId !== recommended.quoteId && !reason) fail(back, "Please give a reason for choosing a vendor other than the recommended one.");
  try {
    await submitAward(id, quoteId, u, reason || undefined);
  } catch (e) {
    fail(back, (e as Error).message);
  }
  revalidatePath("/", "layout");
  done(back, "Sent for approval. The purchase order is raised automatically once it is approved.");
}

export async function checkMailNow(fd: FormData) {
  await requireUser(PROCUREMENT_ROLES);
  const id = str(fd, "rfqId");
  const back = id ? `/procurement/rfq/${id}` : "/procurement/enquiries";
  if (!inboxConfigured()) fail(back, "The purchase mailbox is not connected yet (the Gmail app password, SMTP_PASS, is missing).");
  const r = await checkInbox();
  revalidatePath("/procurement", "layout");
  if (r.error) fail(back, `Could not read the mailbox: ${r.error}`);
  done(back, r.filed ? `${r.filed} new supplier email(s) filed on their enquiries.` : "Mailbox checked. No new supplier emails.");
}

export async function sendReminders(fd: FormData) {
  await requireUser(BUYERS);
  const id = str(fd, "rfqId");
  const n = await remind(id, true);
  done(`/procurement/rfq/${id}`, `Reminder sent to ${n} vendor(s).`);
}

export async function closeQuotes(fd: FormData) {
  const u = await requireUser(BUYERS);
  const id = str(fd, "rfqId");
  await db.rfq.update({ where: { id }, data: { quoteDueAt: new Date(Date.now() - 1000) } });
  await audit(u, "UPDATE", "Rfq", id, "Closed quotes early");
  await evaluateRfq(id);
  revalidatePath("/", "layout");
  done(`/procurement/rfq/${id}`, "Quotes closed and comparison built.");
}

export async function cancelRfq(fd: FormData) {
  const u = await requireUser(BUYERS);
  const id = str(fd, "rfqId");
  const reason = str(fd, "reason");
  if (!reason) fail(`/procurement/rfq/${id}`, "Please give a reason for cancelling.");
  const r = await db.rfq.findUniqueOrThrow({ where: { id } });
  if (["IN_APPROVAL", "AWARDED"].includes(r.status)) fail(`/procurement/rfq/${id}`, "This enquiry is already with the approvers or ordered.");
  await db.rfq.update({ where: { id }, data: { status: "CANCELLED", note: reason } });
  await audit(u, "UPDATE", "Rfq", id, `Cancelled ${r.number}: ${reason}`);
  done("/procurement/enquiries", `${r.number} cancelled.`);
}

/** Demo only: fill in realistic quotes from the vendors who have not answered yet. */
export async function simulateQuotes(fd: FormData) {
  await requireUser(BUYERS);
  if (process.env.DEMO_MODE === "false") fail("/procurement", "Demo tools are switched off.");
  const id = str(fd, "rfqId");
  const rfq = await db.rfq.findUniqueOrThrow({ where: { id }, include: { invites: true, material: true } });
  const base = rfq.material.refRate ?? 1000;
  let i = 0;
  for (const inv of rfq.invites.filter((x) => x.status !== "QUOTED" && x.status !== "DECLINED")) {
    const swing = [0.97, 1.02, 0.995, 1.05, 1.01][i++ % 5];
    await db.rfqQuote.upsert({
      where: { rfqId_vendorId: { rfqId: id, vendorId: inv.vendorId } },
      create: {
        rfqId: id, vendorId: inv.vendorId, rate: Math.round(base * swing * 100) / 100, gstPct: rfq.material.category === "Cement" ? 28 : 18,
        freight: [0, 15000, 8000, 0, 25000][i % 5], deliveryDays: Math.max(2, rfq.material.leadTimeDays + [-3, 0, 4, -1, 9][i % 5]),
        paymentTerms: ["30 days credit", "50% advance, 50% on delivery", "45 days credit", "On delivery", "30 days credit"][i % 5], validityDays: 15, remarks: "Demo quote",
      },
      update: {},
    });
    await db.rfqInvite.update({ where: { id: inv.id }, data: { status: "QUOTED" } });
  }
  await evaluateRfq(id);
  revalidatePath("/", "layout");
  done(`/procurement/rfq/${id}`, "Demo quotes added from every vendor.");
}

export async function saveMaterial(fd: FormData) {
  const u = await requireUser(SETUP);
  const id = str(fd, "id");
  const data = {
    leadTimeDays: Math.max(0, Math.round(numVal(fd, "leadTimeDays"))),
    quoteDays: Math.max(1, Math.round(numVal(fd, "quoteDays"))),
    refRate: Number.isFinite(numVal(fd, "refRate")) ? numVal(fd, "refRate") : null,
  };
  if (Object.values(data).some((v) => typeof v === "number" && !Number.isFinite(v))) fail("/procurement/setup", "Enter numbers for lead time and quote days.");
  const before = await db.material.findUniqueOrThrow({ where: { id } });
  await db.material.update({ where: { id }, data });
  await audit(u, "UPDATE", "Material", id, `Updated ${before.name}`, { before: { leadTimeDays: before.leadTimeDays, quoteDays: before.quoteDays, refRate: before.refRate }, after: data });
  done("/procurement/setup", `${before.name} saved.`);
}

export async function addMaterial(fd: FormData) {
  const u = await requireUser(SETUP);
  const name = str(fd, "name");
  if (!name) fail("/procurement/setup", "Give the material a name.");
  const m = await db.material.create({
    data: {
      code: `M-${String((await db.material.count()) + 1).padStart(3, "0")}`, name, unit: str(fd, "unit") || "nos", category: str(fd, "category"),
      costCodeId: str(fd, "costCodeId"), leadTimeDays: Math.round(numVal(fd, "leadTimeDays")) || 7, quoteDays: Math.round(numVal(fd, "quoteDays")) || 5,
      refRate: Number.isFinite(numVal(fd, "refRate")) ? numVal(fd, "refRate") : null, specs: str(fd, "specs") || null,
    },
  });
  await audit(u, "CREATE", "Material", m.id, `Added material ${m.name}`);
  done("/procurement/setup", `${m.name} added.`);
}

export async function addRequirement(fd: FormData) {
  const u = await requireUser(SETUP);
  const milestone = await db.milestone.findUniqueOrThrow({ where: { id: str(fd, "milestoneId") } });
  if (!canSeeProject(u, milestone.projectId)) fail("/procurement/setup", "Not your project");
  const qty = numVal(fd, "qty");
  if (!(qty > 0)) fail("/procurement/setup", "Enter the quantity needed.");
  const r = await db.materialRequirement.create({
    data: { projectId: milestone.projectId, milestoneId: milestone.id, materialId: str(fd, "materialId"), qty, neededDaysBeforeStart: Math.round(numVal(fd, "buffer")) || 7 },
    include: { material: true },
  });
  await audit(u, "CREATE", "MaterialRequirement", r.id, `${milestone.name} needs ${qty} ${r.material.unit} ${r.material.name}`);
  done("/procurement/setup?tab=quantities", "Quantity added to the buying plan.");
}

export async function removeRequirement(fd: FormData) {
  const u = await requireUser(SETUP);
  const id = str(fd, "id");
  const r = await db.materialRequirement.findUniqueOrThrow({ where: { id }, include: { rfqs: true, material: true } });
  if (r.rfqs.some((x) => x.status !== "CANCELLED")) fail("/procurement/setup?tab=quantities", "An enquiry already exists for this need. Cancel the enquiry first.");
  await db.materialRequirement.delete({ where: { id } });
  await audit(u, "DELETE", "MaterialRequirement", id, `Removed ${r.material.name} from the buying plan`);
  done("/procurement/setup?tab=quantities", "Removed from the buying plan.");
}

export async function sendTestEmail() {
  const u = await requireUser(["MD", "GM_PROJECTS", "PURCHASE"]);
  const to = emailTestTo() || process.env.SMTP_USER || process.env.MAIL_FROM || "";
  const m = await sendEmail(to, "Vida OS test email", `Hello,\n\nThis is a test from Vida OS, sent by ${u.name}. If you can read this, procurement emails are working.\n\nVida OS`);
  if (m.status === "SENT") done("/procurement/outbox", `Test email sent to ${emailTestTo() || to}. Check that inbox.`);
  fail("/procurement/outbox", `Test email failed: ${m.error ?? m.status}`);
}

export async function newEnquiry(fd: FormData) {
  const u = await requireUser(BUYERS);
  const materialId = str(fd, "materialId");
  const back = `/procurement/enquiries/new?material=${materialId}`;
  const projectId = str(fd, "projectId");
  if (!canSeeProject(u, projectId)) fail(back, "Not your project");
  const qty = numVal(fd, "qty");
  const needOnSite = new Date(str(fd, "needOnSite") + "T09:00:00+05:30");
  const vendorIds = fd.getAll("vendorIds").map(String);
  if (!(qty > 0)) fail(back, "Enter the quantity.");
  if (Number.isNaN(needOnSite.getTime()) || needOnSite.getTime() < Date.now()) fail(back, "Pick a future need date.");
  if (vendorIds.length < 1) fail(back, "Choose at least one supplier (three for a fair comparison).");
  const rfq = await createAdhocRfq({ projectId, materialId, qty, needOnSite, vendorIds, live: fd.get("live") === "1", note: str(fd, "note") }, u);
  revalidatePath("/procurement", "layout");
  done(`/procurement/rfq/${rfq.id}`, `Enquiry ${rfq.number} sent to ${vendorIds.length} supplier(s)${fd.get("live") === "1" ? " for real" : " (test mode)"}.`);
}
