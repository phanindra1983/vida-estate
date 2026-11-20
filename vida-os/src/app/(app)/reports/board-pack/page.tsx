import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { projectSnapshot } from "@/lib/mis";
import { LEAD_SOURCES } from "@/lib/constants";
import { inr, pct, date } from "@/lib/format";
import { Table, Progress, Badge } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";

export default async function BoardPack({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requireUser(["MD", "FINANCE_HEAD", "SALES_HEAD", "GM_PROJECTS"]);
  const { month } = await searchParams;
  const ref = month ? new Date(month + "-01T00:00:00+05:30") : new Date();
  const from = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const to = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  const label = from.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const snaps = await projectSnapshot(user.projectIds);
  const [leadsBySource, bookingsMonth, receiptsMonth, posMonth, billsPaid, openApprovals] = await Promise.all([
    db.lead.groupBy({ by: ["source"], where: { createdAt: { gte: from, lt: to } }, _count: true }),
    db.booking.findMany({ where: { bookedAt: { gte: from, lt: to }, status: { not: "CANCELLED" } }, select: { agreementValue: true, lead: { select: { source: true } } } }),
    db.receipt.aggregate({ where: { receivedAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    db.purchaseOrder.aggregate({ where: { createdAt: { gte: from, lt: to }, status: { notIn: ["REJECTED"] } }, _sum: { amount: true }, _count: true }),
    db.vendorBill.aggregate({ where: { paidAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    db.approvalRequest.count({ where: { status: "PENDING" } }),
  ]);
  const totalLeads = leadsBySource.reduce((s, l) => s + l._count, 0);
  const bookedBySource = (src: string) => bookingsMonth.filter((b) => b.lead.source === src).length;

  const T = snaps.reduce((a, s) => ({ value: a.value + s.salesValue, collected: a.collected + s.collected, demanded: a.demanded + s.demanded, overdue: a.overdue + s.overdue, budget: a.budget + s.budget.total, committed: a.committed + s.budget.committed, actual: a.actual + s.budget.actual }), { value: 0, collected: 0, demanded: 0, overdue: 0, budget: 0, committed: 0, actual: 0 });

  return (
    <div className="mx-auto max-w-4xl bg-white p-6 md:p-10 print:p-0">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <form className="flex items-center gap-2 text-sm">
          <label htmlFor="m" className="text-stone">Month</label>
          <input id="m" type="month" name="month" defaultValue={`${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`} className="input w-44" />
          <button className="min-h-11 rounded-lg border border-line px-4">Show</button>
        </form>
        <PrintButton label="Download PDF" />
      </div>

      <header className="flex items-end justify-between border-b border-ink pb-6">
        <div>
          <img src="/logo-dark.svg" alt="Vida Estates" className="w-32" />
          <p className="eyebrow mt-6">Board pack · confidential</p>
          <h1 className="mt-1 font-serif text-4xl">{label}</h1>
        </div>
        <p className="text-right text-xs text-stone">Prepared from Vida OS<br />{date(new Date())}</p>
      </header>

      <Section n="1" title="Summary">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Kpi label="Bookings this month" value={String(bookingsMonth.length)} sub={inr(bookingsMonth.reduce((s, b) => s + b.agreementValue, 0))} />
          <Kpi label="Collected this month" value={inr(receiptsMonth._sum.amount ?? 0)} sub={`${inr(T.overdue)} overdue overall`} />
          <Kpi label="Orders placed this month" value={inr(posMonth._sum.amount ?? 0)} sub={`${posMonth._count} purchase orders`} />
          <Kpi label="Vendor payments" value={inr(billsPaid._sum.amount ?? 0)} sub={`${openApprovals} approvals open`} />
        </div>
      </Section>

      <Section n="2" title="Sales and collections by project">
        <Table head={["Project", "Units sold", { label: "Sales value", num: true }, { label: "Demanded", num: true }, { label: "Collected", num: true }, { label: "Overdue", num: true }]}>
          {snaps.map((s) => (
            <tr key={s.project.id}>
              <td className="font-medium">{s.project.name}</td>
              <td>{s.units.booked} / {s.units.total} ({pct(s.units.booked, s.units.total)}%)</td>
              <td className="num">{inr(s.salesValue)}</td>
              <td className="num">{inr(s.demanded)}</td>
              <td className="num">{inr(s.collected)}</td>
              <td className="num">{s.overdue ? <span className="text-bad">{inr(s.overdue)}</span> : "–"}</td>
            </tr>
          ))}
          <tr className="font-medium"><td>Total</td><td /><td className="num">{inr(T.value)}</td><td className="num">{inr(T.demanded)}</td><td className="num">{inr(T.collected)}</td><td className="num">{inr(T.overdue)}</td></tr>
        </Table>
      </Section>

      <Section n="3" title="Lead sources this month">
        <Table head={["Source", { label: "Leads", num: true }, { label: "Share", num: true }, { label: "Bookings", num: true }]} empty="No leads recorded this month.">
          {leadsBySource.sort((a, b) => b._count - a._count).map((l) => (
            <tr key={l.source}><td>{LEAD_SOURCES[l.source] ?? l.source}</td><td className="num">{l._count}</td><td className="num">{pct(l._count, totalLeads)}%</td><td className="num">{bookedBySource(l.source)}</td></tr>
          ))}
        </Table>
      </Section>

      <Section n="4" title="Cost against budget">
        {snaps.map((s) => (
          <div key={s.project.id} className="mb-6">
            <p className="mb-2 font-medium">{s.project.name} <span className="text-sm font-normal text-stone">· budget {inr(s.budget.total)}, committed {inr(s.budget.committed)} ({pct(s.budget.committed, s.budget.total)}%), actual {inr(s.budget.actual)}</span></p>
            <Table head={["Cost head", { label: "Budget", num: true }, { label: "Committed", num: true }, { label: "Actual", num: true }, "Used"]}>
              {s.budget.rows.filter((r) => r.committed > 0 || r.usedPct > 0).map((r) => (
                <tr key={r.lineId}>
                  <td>{r.code} · {r.name}</td>
                  <td className="num">{inr(r.budget)}</td>
                  <td className="num">{inr(r.committed)}</td>
                  <td className="num">{inr(r.actual)}</td>
                  <td className="w-32"><span className={r.usedPct > 95 ? "text-bad" : ""}>{r.usedPct}%</span><Progress value={r.usedPct} tone={r.usedPct > 95 ? "bad" : undefined} /></td>
                </tr>
              ))}
            </Table>
          </div>
        ))}
      </Section>

      <Section n="5" title="Construction progress">
        <Table head={["Project", "Milestone", "Planned finish", "Progress", "Status"]}>
          {snaps.flatMap((s) => s.schedule.current.map((m) => ({ m, p: s.project.name }))).map(({ m, p }) => {
            const late = m.plannedEnd.getTime() < Date.now() - 3 * 864e5;
            return (
              <tr key={m.id}>
                <td>{p}</td><td>{m.name}</td><td>{date(m.plannedEnd)}</td><td>{m.progressPct}%</td>
                <td>{late ? <Badge tone="bad">{Math.round((Date.now() - m.plannedEnd.getTime()) / 864e5)} days late</Badge> : <Badge tone="good">On plan</Badge>}</td>
              </tr>
            );
          })}
        </Table>
      </Section>

      <footer className="mt-10 border-t border-line pt-4 text-xs text-stone">
        Figures are live from Vida OS at the time of printing. Amounts include GST where applicable. Demo data.
      </footer>
    </div>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 break-inside-avoid-page">
      <h2 className="mb-4 font-serif text-2xl"><span className="mr-2 text-base text-brass">{n}</span>{title}</h2>
      {children}
    </section>
  );
}
function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border-l-2 border-brass pl-3">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-serif text-2xl">{value}</p>
      <p className="text-xs text-stone">{sub}</p>
    </div>
  );
}
