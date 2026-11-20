import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { procurementPlan, runEngineIfStale, lastRun, APPROVAL_DAYS, type PlanRow } from "@/lib/procurement";
import { date, datetime, num } from "@/lib/format";
import { PageHeader, Card, Stat, Table, Badge, Button, Notice } from "@/components/ui";
import { runNow, sendNow } from "./actions";

export const dynamic = "force-dynamic";

const STATE: Record<PlanRow["state"], { label: string; tone: "neutral" | "good" | "warn" | "bad" | "brass" | "ink" }> = {
  PLANNED: { label: "Planned", tone: "neutral" },
  DUE: { label: "Enquiry due", tone: "warn" },
  OUT: { label: "Enquiries out", tone: "brass" },
  READY: { label: "Comparison ready", tone: "warn" },
  APPROVAL: { label: "Awaiting approval", tone: "warn" },
  ORDERED: { label: "Ordered", tone: "good" },
};

export default async function BuyingPlan({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; project?: string; show?: string }> }) {
  const u = await requireUser(PROCUREMENT_ROLES);
  const sp = await searchParams;
  await runEngineIfStale();
  const [all, run] = await Promise.all([procurementPlan(u.projectIds), lastRun()]);
  const projects = [...new Map(all.map((r) => [r.project.id, r.project])).values()];
  let rows = sp.project ? all.filter((r) => r.project.id === sp.project) : all;
  const in60 = Date.now() + 60 * 864e5;
  if (sp.show !== "all") rows = rows.filter((r) => r.state !== "PLANNED" || r.t.sendOn.getTime() < in60);

  const count = (s: PlanRow["state"]) => all.filter((r) => r.state === s).length;
  const late = all.filter((r) => r.late).length;
  const next = all.find((r) => r.state === "PLANNED");

  return (
    <>
      <PageHeader eyebrow="Procurement engine" title="Buying plan">
        <form action={runNow}><Button variant="secondary">Run engine now</Button></form>
      </PageHeader>

      {sp.ok && <div className="mb-4"><Notice tone="good">{sp.ok}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="bad">{sp.error}</Notice></div>}

      <div className="mb-6">
        <Notice tone="neutral">
          The engine reads the construction programme. For every material a milestone needs, it works back from the start date: on site by, minus the vendor&apos;s lead time = order by,
          minus the quote window and {APPROVAL_DAYS} days for approval = send enquiries on. On that day it sends enquiries to the matching vendors, chases them, builds the comparison
          statement and sends the recommended vendor for approval. Once approved, the purchase order is raised automatically.
          {run && <span className="mt-2 block text-xs text-stone">Last run {datetime(run.at)}: {run.sent} sent, {run.reminded} reminded, {run.ready} comparisons ready. It also runs by itself every few minutes while anyone uses these screens.</span>}
        </Notice>
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Material needs tracked" value={all.length} sub={next ? `Next enquiry ${date(next.t.sendOn)}` : "Nothing planned"} />
        <Stat label="Enquiries out" value={count("OUT")} sub="Waiting for vendor quotes" />
        <Stat label="Comparisons ready" value={count("READY")} sub="Purchase to review" tone={count("READY") ? "warn" : undefined} />
        <Stat label="Awaiting approval" value={count("APPROVAL")} sub={<Link href="/approvals" className="underline">Open approvals</Link>} tone={count("APPROVAL") ? "warn" : undefined} />
        <Stat label="Late to order" value={late} sub="Past the order-by date" tone={late ? "bad" : "good"} />
      </div>

      <form className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <select name="project" defaultValue={sp.project ?? ""} className="input max-w-[14rem]">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select name="show" defaultValue={sp.show ?? ""} className="input max-w-[16rem]">
          <option value="">Next 60 days and open items</option>
          <option value="all">Whole programme</option>
        </select>
        <button className="min-h-11 rounded-lg border border-line bg-white px-4">Show</button>
      </form>

      <Card pad={false}>
        <Table head={["Material", { label: "Quantity", num: true }, "For", "On site by", "Lead time", "Order by", "Enquiry on", "Status", ""]} empty="No material needs in this view. Add quantities under Materials & quantities.">
          {rows.map((r) => (
            <tr key={r.reqId}>
              <td className="font-medium">{r.material.name}<p className="text-xs font-normal text-stone">{r.material.category}</p></td>
              <td className="num">{num(r.qty)} {r.material.unit}</td>
              <td>{r.milestone.name}<p className="text-xs text-stone">{r.project.name}</p></td>
              <td className="whitespace-nowrap">{date(r.t.needOnSite)}</td>
              <td>{r.material.leadTimeDays} d</td>
              <td className="whitespace-nowrap">{date(r.t.orderBy)}{r.late && <p><Badge tone="bad">Late</Badge></p>}</td>
              <td className="whitespace-nowrap">{date(r.t.sendOn)}</td>
              <td>
                <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
                {r.rfq && r.state === "OUT" && <p className="mt-1 text-xs text-stone">{r.rfq.quotes} of {r.rfq.invites} quoted</p>}
              </td>
              <td className="text-right">
                {r.rfq ? <Link href={`/procurement/rfq/${r.rfq.id}`} className="text-sm underline underline-offset-4">{r.rfq.number}</Link>
                  : r.state === "PLANNED" ? <form action={sendNow}><input type="hidden" name="reqId" value={r.reqId} /><Button size="sm" variant="ghost">Send early</Button></form> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
