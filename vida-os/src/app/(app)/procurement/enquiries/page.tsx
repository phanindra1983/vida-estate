import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { runEngineIfStale } from "@/lib/procurement";
import { date, inr, num } from "@/lib/format";
import { PageHeader, Card, Table, Badge, Status, Notice, LinkButton } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Enquiries({ searchParams }: { searchParams: Promise<{ ok?: string; status?: string }> }) {
  const u = await requireUser(PROCUREMENT_ROLES);
  const sp = await searchParams;
  await runEngineIfStale();
  const rfqs = await db.rfq.findMany({
    where: { ...projectScope(u), ...(sp.status ? { status: sp.status } : {}) },
    include: { material: true, quotes: true, _count: { select: { invites: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const projects = new Map((await db.project.findMany()).map((p) => [p.id, p.name]));
  const vendors = new Map((await db.vendor.findMany()).map((v) => [v.id, v.name]));
  const statuses = ["SENT", "READY", "IN_APPROVAL", "AWARDED", "CANCELLED"];

  return (
    <>
      <PageHeader eyebrow="Procurement engine" title="Enquiries & comparisons"><LinkButton href="/procurement/enquiries/new">New enquiry</LinkButton></PageHeader>
      {sp.ok && <div className="mb-4"><Notice tone="good">{sp.ok}</Notice></div>}
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        <Link href="/procurement/enquiries" className={`rounded-full border px-4 py-2 ${!sp.status ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>All</Link>
        {statuses.map((s) => (
          <Link key={s} href={`/procurement/enquiries?status=${s}`} className={`rounded-full border px-4 py-2 ${sp.status === s ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>{s.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Link>
        ))}
      </nav>
      <Card pad={false}>
        <Table head={["Enquiry", "Material", "Project", { label: "Quantity", num: true }, "Quotes", "Quotes close", "Order by", "Recommended", "Status"]} empty="No enquiries yet. The engine sends them when the buying plan says so.">
          {rfqs.map((r) => {
            const rec = r.quotes.find((q) => q.id === (r.awardedQuoteId ?? r.recommendedQuoteId));
            return (
              <tr key={r.id}>
                <td><Link href={`/procurement/rfq/${r.id}`} className="font-medium underline-offset-4 hover:underline">{r.number}</Link></td>
                <td>{r.material.name}</td>
                <td>{projects.get(r.projectId)}</td>
                <td className="num">{num(r.qty)} {r.unit}</td>
                <td>{r.quotes.length} of {r._count.invites}</td>
                <td className="whitespace-nowrap">{date(r.quoteDueAt)}</td>
                <td className="whitespace-nowrap">{date(r.orderBy)}{r.status !== "AWARDED" && r.status !== "CANCELLED" && r.orderBy.getTime() < Date.now() && <p><Badge tone="bad">Late</Badge></p>}</td>
                <td>{rec ? <>{vendors.get(rec.vendorId)}<p className="text-xs text-stone">{inr(Math.round((r.qty * rec.rate + rec.freight) * (1 + rec.gstPct / 100)))}</p></> : "–"}</td>
                <td><Status value={r.status} /></td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
