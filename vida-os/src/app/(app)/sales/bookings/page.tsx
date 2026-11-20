import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { COLLECTION_ROLES } from "@/lib/constants";
import { inr, date, pct } from "@/lib/format";
import { isOverdue } from "@/lib/collections";
import { PageHeader, Card, Table, Status, Badge, Progress } from "@/components/ui";
import { Flash, SubNav, one, type SP } from "../_ui";

export const dynamic = "force-dynamic";

export default async function BookingsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser([...COLLECTION_ROLES, "SALES_EXEC"]);
  const sp = await searchParams;
  const projectId = one(sp.project) ?? "";
  const scope = u.projectIds === "ALL" ? {} : { projectId: { in: u.projectIds } };
  const [bookings, projects] = await Promise.all([
    db.booking.findMany({
      where: { unit: { ...scope, ...(projectId ? { projectId } : {}) }, ...(u.role === "SALES_EXEC" ? { lead: { ownerId: u.id } } : {}) },
      include: { unit: { include: { project: true } }, plan: true, demands: { include: { receipts: true } }, receipts: true },
      orderBy: { bookedAt: "desc" },
    }),
    db.project.findMany({ where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } }, orderBy: { name: "asc" } }),
  ]);

  return (
    <>
      <PageHeader eyebrow="Sales" title="Bookings">
        <form method="get" className="flex gap-2">
          <select className="input" name="project" defaultValue={projectId}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="min-h-11 rounded-lg border border-line bg-white px-4 text-sm">Show</button>
        </form>
      </PageHeader>
      <SubNav active="/sales/bookings" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <Card pad={false}>
        <Table head={["Unit", "Buyer", "Plan", { label: "Value", num: true }, { label: "Demanded", num: true }, "Collected", "Status", "Booked"]} empty="No bookings yet.">
          {bookings.map((b) => {
            const demanded = b.demands.reduce((s, d) => s + d.amount, 0);
            const received = b.receipts.reduce((s, r) => s + r.amount, 0);
            const overdue = b.demands.some((d) => isOverdue(d));
            return (
              <tr key={b.id}>
                <td><Link href={`/sales/bookings/${b.id}`} className="font-medium hover:underline">{b.unit.number}</Link><div className="text-xs text-stone">{b.unit.project.name} · {b.unit.type}</div></td>
                <td>{b.buyerName}<div className="text-xs text-stone">{b.buyerPhone}</div></td>
                <td className="text-xs">{b.plan.name}</td>
                <td className="num">{inr(b.agreementValue)}</td>
                <td className="num">{inr(demanded)}</td>
                <td className="min-w-36">
                  <div className="mb-1 flex justify-between text-xs"><span>{inr(received)}</span><span className="text-stone">{pct(received, demanded)}%</span></div>
                  <Progress value={pct(received, demanded)} tone={overdue ? "bad" : undefined} />
                  {overdue && <div className="mt-1"><Badge tone="bad">Overdue</Badge></div>}
                </td>
                <td><Status value={b.status} /></td>
                <td className="text-xs text-stone">{date(b.bookedAt)}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
