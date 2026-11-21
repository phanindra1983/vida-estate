import Link from "next/link";
import { db } from "@/lib/db";
import { LEAD_STAGES } from "@/lib/constants";
import { inr, pct, istDay, istDayStart } from "@/lib/format";
import { ON_SITE_METRES } from "@/lib/telegram-bot";
import { Card, Table, Badge } from "@/components/ui";

/** Owner view additions on the dashboard: site today, money in vs out, and where sales come from. */
export async function OwnerSections({ projectIds }: { projectIds: string[] | "ALL" }) {
  const pScope = projectIds === "ALL" ? {} : { projectId: { in: projectIds } };
  const projects = await db.project.findMany({ where: { ...(projectIds === "ALL" ? {} : { id: { in: projectIds } }), status: { not: "COMPLETED" } }, orderBy: { name: "asc" } });

  // ── Site today
  const today = istDay(), from = istDayStart(0);
  const [reports, attendance, issues, engineers] = await Promise.all([
    db.dailyReport.findMany({ where: { ...pScope, createdAt: { gte: from } }, select: { projectId: true, labourCount: true } }),
    db.attendance.findMany({ where: { ...pScope, day: today }, select: { projectId: true, inMeters: true } }),
    db.siteIssue.findMany({ where: { ...pScope, status: "OPEN" }, select: { projectId: true, kind: true, severity: true } }),
    db.projectAccess.findMany({ where: { ...pScope, user: { role: "SITE_ENGINEER", active: true } }, select: { projectId: true } }),
  ]);

  // ── Money in vs out, last 6 months (IST months)
  const months = [...Array(6)].map((_, i) => {
    const d = new Date(Date.now() + 330 * 60_000);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (5 - i));
    return d.toISOString().slice(0, 7);
  });
  const since = new Date(Date.parse(months[0] + "-01T00:00:00Z") - 330 * 60_000);
  const [receipts, bills] = await Promise.all([
    db.receipt.findMany({ where: { receivedAt: { gte: since }, ...(projectIds === "ALL" ? {} : { booking: { unit: { projectId: { in: projectIds } } } }) }, select: { amount: true, receivedAt: true } }),
    db.vendorBill.findMany({ where: { status: "PAID", paidAt: { gte: since }, ...(projectIds === "ALL" ? {} : { po: { projectId: { in: projectIds } } }) }, select: { amount: true, paidAt: true } }),
  ]);
  const monthOf = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 7);
  const flow = months.map((m) => ({
    m,
    label: new Intl.DateTimeFormat("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(m + "-15T00:00:00Z")),
    inn: receipts.filter((r) => monthOf(r.receivedAt) === m).reduce((a, r) => a + r.amount, 0),
    out: bills.filter((b) => b.paidAt && monthOf(b.paidAt) === m).reduce((a, b) => a + b.amount, 0),
  }));
  const peak = Math.max(1, ...flow.flatMap((f) => [f.inn, f.out]));
  const net = flow.reduce((a, f) => a + f.inn - f.out, 0);

  // ── Where sales come from, last 90 days
  const leads = await db.lead.findMany({ where: { ...pScope, createdAt: { gte: new Date(Date.now() - 90 * 864e5) } }, select: { source: true, stage: true } });
  const order = LEAD_STAGES.map((s) => s.key);
  const reached = (stage: string, key: string) => stage !== "LOST" && order.indexOf(stage) >= order.indexOf(key);
  const funnel = [
    { label: "Leads", n: leads.length },
    { label: "Contacted", n: leads.filter((l) => reached(l.stage, "CONTACTED")).length },
    { label: "Site visit done", n: leads.filter((l) => reached(l.stage, "VISIT_DONE")).length },
    { label: "Booked", n: leads.filter((l) => reached(l.stage, "BOOKED")).length },
  ];
  const sources = [...new Set(leads.map((l) => l.source))]
    .map((s) => ({ s, n: leads.filter((l) => l.source === s).length, booked: leads.filter((l) => l.source === s && reached(l.stage, "BOOKED")).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);

  return (
    <>
      <Card title="Site today" pad={false} className="mb-8">
        <Table head={["Project", "Daily reports", { label: "Labour", num: true }, "Checked in", "Open snags", "Open safety"]} empty="No active projects.">
          {projects.map((p) => {
            const r = reports.filter((x) => x.projectId === p.id);
            const a = attendance.filter((x) => x.projectId === p.id);
            const off = a.filter((x) => x.inMeters != null && x.inMeters > ON_SITE_METRES).length;
            const eng = engineers.filter((x) => x.projectId === p.id).length;
            const snags = issues.filter((x) => x.projectId === p.id && x.kind === "SNAG").length;
            const safety = issues.filter((x) => x.projectId === p.id && x.kind === "SAFETY");
            return (
              <tr key={p.id}>
                <td className="font-medium">{p.name}</td>
                <td><Link href="/projects/reports" className="hover:underline">{r.length}{eng ? ` of ${eng} engineer${eng > 1 ? "s" : ""}` : ""}</Link>{eng > 0 && r.length === 0 && <span className="ml-2"><Badge tone="warn">none yet</Badge></span>}</td>
                <td className="num">{r.reduce((s, x) => s + x.labourCount, 0)}</td>
                <td><Link href="/projects/attendance" className="hover:underline">{a.length}</Link>{off > 0 && <span className="ml-2"><Badge tone="bad">{off} off site</Badge></span>}</td>
                <td><Link href="/projects/issues" className="hover:underline">{snags}</Link></td>
                <td>{safety.length ? <Link href="/projects/issues"><Badge tone="bad">{safety.length}{safety.some((x) => x.severity === "HIGH") ? " · high" : ""}</Badge></Link> : 0}</td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <Card title="Money in vs money out, last 6 months">
          <p className="mb-4 text-sm text-stone">In: buyer receipts. Out: vendor bills paid. Net {net >= 0 ? "in" : "out"} <b className={net >= 0 ? "text-good" : "text-bad"}>{inr(Math.abs(net))}</b>.</p>
          <div className="grid gap-3">
            {flow.map((f) => (
              <div key={f.m} className="grid grid-cols-[3.5rem_1fr] items-center gap-3 text-xs">
                <span className="text-stone">{f.label}</span>
                <div className="grid gap-1">
                  <div className="flex items-center gap-2"><div className="h-2.5 rounded-full bg-good" style={{ width: `${Math.max(1, (f.inn / peak) * 100)}%` }} /><span>{inr(f.inn)}</span></div>
                  <div className="flex items-center gap-2"><div className="h-2.5 rounded-full bg-bad/70" style={{ width: `${Math.max(1, (f.out / peak) * 100)}%` }} /><span>{inr(f.out)}</span></div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 flex gap-4 text-xs text-stone"><span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-good" />In</span><span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-bad/70" />Out</span></p>
        </Card>

        <Card title="Sales funnel, last 90 days">
          <div className="mb-5 grid grid-cols-4 gap-2 text-center">
            {funnel.map((f, i) => (
              <div key={f.label} className="rounded-lg border border-line p-3">
                <p className="font-serif text-2xl">{f.n}</p>
                <p className="text-xs text-stone">{f.label}</p>
                {i > 0 && <p className="mt-1 text-xs">{pct(f.n, funnel[0].n)}%</p>}
              </div>
            ))}
          </div>
          <Table head={["Source", { label: "Leads", num: true }, { label: "Booked", num: true }, { label: "Conversion", num: true }]} empty="No leads in the last 90 days.">
            {sources.map((s) => (
              <tr key={s.s}>
                <td>{s.s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}</td>
                <td className="num">{s.n}</td>
                <td className="num">{s.booked}</td>
                <td className="num">{pct(s.booked, s.n)}%</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
