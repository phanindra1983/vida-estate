import { redirect } from "next/navigation";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { createApproval } from "./approvals";
import { docNo } from "./format";
import type { CurrentUser } from "./auth";
import { COMMITTED_PO } from "./mis";

export { budgetPosition, COMMITTED_PO, ACTUAL_BILL, type BudgetRow } from "./mis";

type Tx = Prisma.TransactionClient | typeof db;

async function committedFor(tx: Tx, projectId: string, costCodeId: string) {
  const r = await tx.purchaseOrder.aggregate({
    where: { projectId, costCodeId, status: { in: COMMITTED_PO } },
    _sum: { amount: true },
  });
  return r._sum.amount ?? 0;
}

export type NewPo = {
  requestId?: string | null;
  projectId: string;
  costCodeId: string;
  vendorId: string;
  item: string;
  qty: number;
  unit: string;
  rate: number;
  gstPct: number;
};

/**
 * Create a PO behind the budget gate. If it would push committed spend past the
 * budget line, the PO waits on a budget revision; otherwise it goes for approval.
 */
export async function createPurchaseOrder(input: NewPo, user: CurrentUser) {
  return db.$transaction(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({ where: { id: input.projectId } });
    const n = (await tx.purchaseOrder.count({ where: { projectId: project.id } })) + 1;
    const number = docNo("PO", project.code, n);
    const amount = Math.round(input.qty * input.rate * (1 + input.gstPct / 100));

    let line = await tx.budgetLine.findUnique({ where: { projectId_costCodeId: { projectId: project.id, costCodeId: input.costCodeId } }, include: { costCode: true } });
    if (!line) {
      const cc = await tx.costCode.findUniqueOrThrow({ where: { id: input.costCodeId } });
      line = await tx.budgetLine.create({
        data: { projectId: project.id, costCodeId: cc.id, description: `${cc.name} · ${project.name}`, amount: 0 },
        include: { costCode: true },
      });
    }
    const committed = await committedFor(tx, project.id, input.costCodeId);
    const overBudget = committed + amount > line.amount;

    const po = await tx.purchaseOrder.create({
      data: {
        number,
        requestId: input.requestId ?? null,
        projectId: project.id,
        costCodeId: input.costCodeId,
        vendorId: input.vendorId,
        item: input.item,
        qty: input.qty,
        unit: input.unit,
        rate: input.rate,
        gstPct: input.gstPct,
        amount,
        status: overBudget ? "BUDGET_HOLD" : "PENDING_APPROVAL",
        createdById: user.id,
      },
    });
    await audit(user, "CREATE", "PurchaseOrder", po.id, `Created ${number} for ${input.item} (₹${amount.toLocaleString("en-IN")})`, { after: po }, tx);

    if (overBudget) {
      const newAmount = committed + amount;
      const rev = await tx.budgetRevision.create({
        data: {
          budgetLineId: line.id,
          oldAmount: line.amount,
          newAmount,
          reason: `Needed for ${number} (${input.item})`,
          requestedById: user.id,
          triggeredByPo: po.id,
        },
      });
      await createApproval(tx, {
        action: "BUDGET_REVISION",
        entityType: "BudgetRevision",
        entityId: rev.id,
        title: `${line.costCode.name} · ${project.name}: budget for ${number}`,
        amount: newAmount - line.amount,
        projectId: project.id,
      }, user);
    } else {
      await createApproval(tx, {
        action: "PURCHASE_ORDER",
        entityType: "PurchaseOrder",
        entityId: po.id,
        title: `${number} · ${input.item}`,
        amount,
        projectId: project.id,
      }, user);
    }

    if (input.requestId) await tx.materialRequest.update({ where: { id: input.requestId }, data: { status: "ORDERED" } });
    return { po, overBudget };
  });
}

/** Total quantity received and already billed for a PO. */
export async function poQuantities(poId: string, tx: Tx = db) {
  const [rec, billed] = await Promise.all([
    tx.goodsReceipt.aggregate({ where: { poId }, _sum: { qty: true } }),
    tx.vendorBill.aggregate({ where: { poId }, _sum: { qty: true } }),
  ]);
  return { received: rec._sum.qty ?? 0, billed: billed._sum.qty ?? 0 };
}

/** How far a milestone is behind plan, in days. */
export function milestoneHealth(m: { status: string; plannedStart: Date; plannedEnd: Date; progressPct: number }, now = Date.now()) {
  if (m.status === "DONE") return { delayed: false, slipDays: 0 };
  const start = m.plannedStart.getTime();
  const end = m.plannedEnd.getTime();
  const durDays = Math.max(1, (end - start) / 864e5);
  if (now > end) return { delayed: true, slipDays: Math.round((now - end) / 864e5) };
  if (now < start) return { delayed: false, slipDays: 0 };
  const expected = ((now - start) / (end - start)) * 100;
  const slipDays = Math.round(((expected - m.progressPct) / 100) * durDays);
  return { delayed: slipDays > 3, slipDays: Math.max(0, slipDays) };
}

export type SavedPhoto = { path: string; takenAt: string };

/** Save uploaded images under public/uploads/<folder>/<yyyy-mm-dd>/. */
export async function saveImages(files: File[], folder: string): Promise<SavedPhoto[]> {
  const day = new Date().toISOString().slice(0, 10);
  const rel = path.join("uploads", folder, day);
  const abs = path.join(process.cwd(), "public", rel);
  await mkdir(abs, { recursive: true });
  const out: SavedPhoto[] = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) throw new Error(`${f.name} is not an image`);
    if (f.size > 6 * 1024 * 1024) throw new Error(`${f.name} is larger than 6 MB`);
    const ext = f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
    const name = `${randomUUID()}.${ext}`;
    await writeFile(path.join(abs, name), Buffer.from(await f.arrayBuffer()));
    out.push({ path: "/" + path.posix.join("uploads", folder, day, name), takenAt: new Date().toISOString() });
  }
  return out;
}

export function imageFiles(fd: FormData, key: string): File[] {
  return fd.getAll(key).filter((v): v is File => typeof v !== "string" && v.size > 0);
}

export function str(fd: FormData, key: string) {
  return String(fd.get(key) ?? "").trim();
}
export function numVal(fd: FormData, key: string) {
  const v = Number(String(fd.get(key) ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : NaN;
}

/** Send the user back to a page with a plain error message. */
export function fail(to: string, message: string): never {
  const sep = to.includes("?") ? "&" : "?";
  redirect(`${to}${sep}error=${encodeURIComponent(message)}`);
}
export function done(to: string, message: string): never {
  const sep = to.includes("?") ? "&" : "?";
  redirect(`${to}${sep}ok=${encodeURIComponent(message)}`);
}

export async function userNames(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  const users = await db.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}
