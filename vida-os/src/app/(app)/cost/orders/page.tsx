import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { PROCUREMENT_ROLES, ROLE_LABEL } from "@/lib/constants";
import { date, inr, pct } from "@/lib/format";
import { pendingRole } from "@/lib/approvals";
import { PageHeader, Card, Table, Status, Progress, Badge } from "@/components/ui";
import { Flash } from "../../projects/_components/Flash";

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; status?: string }> }) {
  const user = await requireUser(PROCUREMENT_ROLES);
  const sp = await searchParams;
  const orders = await db.purchaseOrder.findMany({
    where: { ...projectScope(user), ...(sp.status ? { status: sp.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 150,
    include: { project: { select: { name: true } }, vendor: { select: { name: true } }, receipts: { select: { qty: true } } },
  });

  // Who each open PO is waiting for (budget revision first, then the PO approval chain).
  const revs = await db.budgetRevision.findMany({ where: { status: "PENDING", triggeredByPo: { in: orders.map((o) => o.id) } }, select: { id: true, triggeredByPo: true } });
  const reqs = await db.approvalRequest.findMany({
    where: { status: "PENDING", entityId: { in: [...orders.map((o) => o.id), ...revs.map((r) => r.id)] } },
    select: { entityId: true, action: true, currentLevel: true, requiredLevel: true },
  });
  const waiting = new Map<string, string>();
  for (const r of reqs) {
    const role = await pendingRole(db, r);
    const poId = r.action === "BUDGET_REVISION" ? revs.find((x) => x.id === r.entityId)?.triggeredByPo : r.entityId;
    if (poId && role) waiting.set(poId, `${r.action === "BUDGET_REVISION" ? "Budget revision · " : ""}${ROLE_LABEL[role] ?? role} (level ${r.currentLevel} of ${r.requiredLevel})`);
  }

  const filters = ["", "BUDGET_HOLD", "PENDING_APPROVAL", "APPROVED", "PARTLY_RECEIVED", "RECEIVED", "REJECTED"];

  return (
    <>
      <PageHeader eyebrow="Cost" title="Purchase orders">
        <span className="text-sm text-stone">New POs are created from an approved material request with 3 quotes.</span>
      </PageHeader>
      <Flash sp={sp} />
      <div className="mb-5 flex flex-wrap gap-2">
        {filters.map((f) => (
          <Link key={f || "all"} href={f ? `/cost/orders?status=${f}` : "/cost/orders"}
            className={`inline-flex min-h-9 items-center rounded-full border px-3 text-xs ${(sp.status ?? "") === f ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-2"}`}>
            {f ? f.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "All"}
          </Link>
        ))}
      </div>
      <Card pad={false}>
        <Table head={["PO", "Project", "Vendor", "Item", { label: "Amount", num: true }, "Received", "Status", "Waiting for"]} empty="No purchase orders match.">
          {orders.map((o) => {
            const rec = o.receipts.reduce((s, r) => s + r.qty, 0);
            const p = pct(rec, o.qty);
            return (
              <tr key={o.id}>
                <td className="whitespace-nowrap"><Link href={`/cost/orders/${o.id}`} className="font-medium underline-offset-4 hover:underline">{o.number}</Link><div className="text-xs text-stone">{date(o.createdAt)}</div></td>
                <td>{o.project.name}</td>
                <td>{o.vendor.name}</td>
                <td className="max-w-56">{o.item}</td>
                <td className="num">{inr(o.amount)}</td>
                <td className="min-w-28"><div className="mb-1 text-xs">{p}%</div><Progress value={p} tone={p >= 100 ? "good" : undefined} /></td>
                <td><Status value={o.status} /></td>
                <td className="text-xs">{waiting.get(o.id) ? <Badge tone="warn">{waiting.get(o.id)}</Badge> : <span className="text-stone">–</span>}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
