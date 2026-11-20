import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { PROCUREMENT_ROLES, ROLE_LABEL, APPROVAL_ACTIONS } from "@/lib/constants";
import { date, datetime, inr, num } from "@/lib/format";
import { pendingRole } from "@/lib/approvals";
import { userNames } from "@/lib/cost";
import { PageHeader, Card, Table, Status, Badge, Notice, LinkButton } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { Flash } from "../../../projects/_components/Flash";

export default async function OrderDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(PROCUREMENT_ROLES);
  const { id } = await params;
  const sp = await searchParams;
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { project: true, vendor: true, costCode: true, request: true, receipts: { orderBy: { receivedAt: "asc" } }, bills: { orderBy: { createdAt: "asc" } } },
  });
  if (!po || !canSeeProject(user, po.projectId)) notFound();

  const revisions = await db.budgetRevision.findMany({ where: { triggeredByPo: po.id } });
  const approvals = await db.approvalRequest.findMany({
    where: { entityId: { in: [po.id, ...revisions.map((r) => r.id)] } },
    include: { steps: { orderBy: { level: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  const names = await userNames([po.createdById, ...approvals.flatMap((a) => [a.requestedById, ...a.steps.map((s) => s.decidedById)]), ...po.receipts.map((r) => r.receivedById)]);
  const waitingFor = await Promise.all(approvals.filter((a) => a.status === "PENDING").map(async (a) => ({ id: a.id, role: await pendingRole(db, a) })));

  const received = po.receipts.reduce((s, r) => s + r.qty, 0);
  const base = po.qty * po.rate;
  const gst = po.amount - Math.round(base);
  const canReceive = ["APPROVED", "PARTLY_RECEIVED"].includes(po.status);

  return (
    <>
      <style>{`@media print { .po-sheet { border: 0 !important; box-shadow: none !important; } }`}</style>
      <div className="no-print">
        <PageHeader eyebrow={`Cost · ${po.project.name}`} title={po.number}>
          <Status value={po.status} />
          {canReceive && <LinkButton href={`/cost/receipts?po=${po.id}`} variant="secondary">Receive goods</LinkButton>}
          <PrintButton label="Print PO" />
        </PageHeader>
        <Flash sp={sp} />
        {po.status === "BUDGET_HOLD" && (
          <div className="mb-6"><Notice tone="bad">This PO would take {po.costCode.name} over its budget. It is on hold until the budget revision below is approved, then it goes for PO approval automatically.</Notice></div>
        )}
        {po.status !== "APPROVED" && po.status !== "PARTLY_RECEIVED" && po.status !== "RECEIVED" && po.status !== "CLOSED" && (
          <div className="mb-6"><Notice tone="neutral">Goods can be received only after the PO is fully approved.</Notice></div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* Printable purchase order */}
        <section className="po-sheet rounded-xl border border-line bg-white p-8">
          <div className="flex items-start justify-between gap-6 border-b border-line pb-6">
            <div>
              <img src="/logo-dark.svg" alt="Vida Estates" className="w-32" />
              <p className="mt-3 text-xs text-stone">Vida Estates · Hyderabad, Telangana</p>
            </div>
            <div className="text-right">
              <p className="eyebrow">Purchase order</p>
              <p className="mt-1 font-serif text-2xl">{po.number}</p>
              <p className="text-xs text-stone">Date {date(po.createdAt)}</p>
            </div>
          </div>
          <div className="grid gap-6 py-6 text-sm sm:grid-cols-2">
            <div>
              <p className="eyebrow mb-1">Vendor</p>
              <p className="font-medium">{po.vendor.name}</p>
              {po.vendor.gstin && <p className="text-stone">GSTIN {po.vendor.gstin}</p>}
              {po.vendor.phone && <p className="text-stone">{po.vendor.phone}</p>}
            </div>
            <div>
              <p className="eyebrow mb-1">Deliver to</p>
              <p className="font-medium">{po.project.name} site</p>
              <p className="text-stone">{po.project.location}</p>
              <p className="text-stone">Cost centre {po.project.code} · {po.costCode.code} {po.costCode.name}</p>
            </div>
          </div>
          <Table head={["Item", { label: "Qty", num: true }, { label: "Rate", num: true }, { label: "Amount", num: true }]}>
            <tr>
              <td>{po.item}{po.request && <div className="text-xs text-stone">Against {po.request.number}</div>}</td>
              <td className="num">{num(po.qty, 2)} {po.unit}</td>
              <td className="num">₹{num(po.rate, 2)}</td>
              <td className="num">{inr(Math.round(base), { exact: true })}</td>
            </tr>
          </Table>
          <dl className="ml-auto mt-4 grid max-w-xs gap-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-stone">Subtotal</dt><dd>{inr(Math.round(base), { exact: true })}</dd></div>
            <div className="flex justify-between"><dt className="text-stone">GST {po.gstPct}%</dt><dd>{inr(gst, { exact: true })}</dd></div>
            <div className="flex justify-between border-t border-line pt-1.5 font-medium"><dt>Total</dt><dd>{inr(po.amount, { exact: true })}</dd></div>
          </dl>
          <div className="mt-8 border-t border-line pt-4 text-xs text-stone">
            <p className="font-medium text-ink-2">Terms</p>
            <p className="mt-1">Delivery to site with a delivery challan quoting this PO number. Quantities are accepted only as received and recorded by Vida site stores. Payment against a matching tax invoice, subject to TDS. Payment terms, warranty and penalties: to be added by Vida Estates.</p>
            <p className="mt-6">Authorised signatory, Vida Estates</p>
          </div>
        </section>

        <div className="no-print grid content-start gap-6">
          <Card title="Approval history">
            {approvals.length === 0 && <p className="text-sm text-stone">No approval records.</p>}
            <ol className="grid gap-4">
              {approvals.map((a) => (
                <li key={a.id} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{APPROVAL_ACTIONS[a.action] ?? a.action}</p>
                    <Status value={a.status} />
                  </div>
                  <p className="text-xs text-stone">{inr(a.amount)} · raised by {names.get(a.requestedById) ?? "System"}, {datetime(a.createdAt)}</p>
                  <ul className="mt-2 grid gap-1.5 border-l border-line pl-3">
                    {a.steps.map((s) => (
                      <li key={s.id} className="text-xs">
                        <span className={s.decision === "APPROVED" ? "text-good" : "text-bad"}>{s.decision === "APPROVED" ? "Approved" : "Rejected"}</span>
                        {" "}by {names.get(s.decidedById) ?? "–"} ({ROLE_LABEL[s.role] ?? s.role}), {datetime(s.decidedAt)}
                        {s.comment && <span className="text-stone">: {s.comment}</span>}
                      </li>
                    ))}
                    {waitingFor.filter((w) => w.id === a.id).map((w) => (
                      <li key={w.id} className="text-xs"><Badge tone="warn">Waiting for {ROLE_LABEL[w.role ?? ""] ?? w.role}</Badge></li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </Card>

          <Card title={`Goods received · ${num(received, 2)} of ${num(po.qty, 2)} ${po.unit}`} pad={false}>
            <Table head={["GRN", "Date", { label: "Qty", num: true }, "Challan"]} empty="Nothing received yet.">
              {po.receipts.map((g) => (
                <tr key={g.id}>
                  <td>{g.number}<div className="text-xs text-stone">{names.get(g.receivedById)}</div></td>
                  <td className="whitespace-nowrap">{date(g.receivedAt)}</td>
                  <td className="num">{num(g.qty, 2)}</td>
                  <td>{g.photo ? <a href={g.photo} target="_blank" rel="noreferrer" className="underline underline-offset-4">{g.challanNo}</a> : g.challanNo}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Vendor bills" pad={false}>
            <Table head={["Bill", { label: "Amount", num: true }, "Match", "Status"]} empty="No bills yet.">
              {po.bills.map((b) => (
                <tr key={b.id}>
                  <td>{b.billNo}<div className="text-xs text-stone">{date(b.billDate)}</div></td>
                  <td className="num">{inr(b.amount)}</td>
                  <td><Status value={b.match} /></td>
                  <td><Status value={b.status} /></td>
                </tr>
              ))}
            </Table>
            <div className="border-t border-line px-5 py-3 text-xs"><Link href="/cost/bills" className="underline underline-offset-4">All vendor bills</Link></div>
          </Card>
        </div>
      </div>
    </>
  );
}
