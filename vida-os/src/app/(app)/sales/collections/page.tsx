import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { COLLECTION_ROLES } from "@/lib/constants";
import { inr, date, pct } from "@/lib/format";
import { isOverdue } from "@/lib/collections";
import { PageHeader, Card, Table, Stat, Progress, Badge } from "@/components/ui";
import { SubNav, waLink } from "../_ui";

export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const u = await requireUser(COLLECTION_ROLES);
  const scope = u.projectIds === "ALL" ? {} : { projectId: { in: u.projectIds } };
  const [demands, receipts, projects, users] = await Promise.all([
    db.demand.findMany({
      where: { booking: { status: { not: "CANCELLED" }, unit: scope } },
      include: { stage: true, receipts: true, booking: { include: { unit: { include: { project: true } }, lead: true } } },
    }),
    db.receipt.findMany({ where: { booking: { unit: scope } }, select: { amount: true, booking: { select: { unit: { select: { projectId: true } } } } } }),
    db.project.findMany({ where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } }, orderBy: { name: "asc" } }),
    db.user.findMany({ select: { id: true, name: true } }),
  ]);
  const name = new Map(users.map((x) => [x.id, x.name]));
  const open = (d: (typeof demands)[number]) => d.amount - d.receipts.reduce((s, r) => s + r.amount, 0);

  const rows = projects.map((p) => {
    const ds = demands.filter((d) => d.booking.unit.projectId === p.id);
    const demanded = ds.reduce((s, d) => s + d.amount, 0);
    const received = receipts.filter((r) => r.booking.unit.projectId === p.id).reduce((s, r) => s + r.amount, 0);
    const overdue = ds.filter((d) => isOverdue(d)).reduce((s, d) => s + open(d), 0);
    return { p, demanded, received, overdue };
  });
  const tot = rows.reduce((a, r) => ({ demanded: a.demanded + r.demanded, received: a.received + r.received, overdue: a.overdue + r.overdue }), { demanded: 0, received: 0, overdue: 0 });

  const overdueList = demands
    .filter((d) => isOverdue(d))
    .map((d) => ({ d, days: Math.floor((Date.now() - d.dueDate.getTime()) / 864e5), bal: open(d) }))
    .sort((a, b) => b.days - a.days);

  return (
    <>
      <PageHeader eyebrow="Sales" title="Collections" />
      <SubNav active="/sales/collections" />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Demanded" value={inr(tot.demanded)} sub="All demand letters raised" />
        <Stat label="Received" value={inr(tot.received)} tone="good" sub={`${pct(tot.received, tot.demanded)}% collection efficiency`} />
        <Stat label="Overdue" value={inr(tot.overdue)} tone={tot.overdue ? "bad" : "good"} sub={`${overdueList.length} demand${overdueList.length === 1 ? "" : "s"} past due date`} />
      </div>

      <Card title="By project" pad={false} className="mb-6">
        <Table head={["Project", { label: "Demanded", num: true }, { label: "Received", num: true }, "Collected", { label: "Overdue", num: true }]}>
          {rows.map((r) => (
            <tr key={r.p.id}>
              <td className="font-medium">{r.p.name}</td>
              <td className="num">{inr(r.demanded)}</td>
              <td className="num">{inr(r.received)}</td>
              <td className="min-w-40"><div className="mb-1 text-xs text-stone">{pct(r.received, r.demanded)}%</div><Progress value={pct(r.received, r.demanded)} /></td>
              <td className="num">{r.overdue > 0 ? <span className="text-bad">{inr(r.overdue)}</span> : "–"}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Overdue, longest first" pad={false}>
        <Table head={["Buyer", "Unit", "Instalment", { label: "Balance", num: true }, "Overdue", "Owner", ""]} empty="Nothing is overdue.">
          {overdueList.map(({ d, days, bal }) => (
            <tr key={d.id}>
              <td>{d.booking.buyerName}<div className="text-xs text-stone">{d.booking.buyerPhone}</div></td>
              <td><Link href={`/sales/bookings/${d.bookingId}`} className="hover:underline">{d.booking.unit.number}</Link><div className="text-xs text-stone">{d.booking.unit.project.name}</div></td>
              <td className="text-xs">{d.stage.name}<div className="text-stone">{d.number} · due {date(d.dueDate)}</div></td>
              <td className="num">{inr(bal)}</td>
              <td><Badge tone={days > 30 ? "bad" : "warn"}>{days} days</Badge></td>
              <td className="text-xs">{d.booking.lead.ownerId ? name.get(d.booking.lead.ownerId) : "–"}</td>
              <td className="whitespace-nowrap text-xs">
                <a className="underline underline-offset-4" href={`tel:+91${d.booking.buyerPhone}`}>Call</a>{" · "}
                <a className="underline underline-offset-4" target="_blank" rel="noreferrer" href={waLink(d.booking.buyerPhone, `Hello ${d.booking.buyerName.split(" ")[0]}, a gentle reminder from Vida Estates: ${inr(bal, { exact: true })} for ${d.stage.name.toLowerCase()} on unit ${d.booking.unit.number} was due on ${date(d.dueDate)}. Please share the payment reference once paid. Thank you.`)}>Remind</a>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
