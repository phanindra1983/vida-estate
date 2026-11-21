import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { projectSnapshot, needsEscalation } from "@/lib/mis";
import { ROLE_LABEL, SALES_ROLES } from "@/lib/constants";
import { inr, pct, date } from "@/lib/format";
import { PageHeader, Card, Stat, Table, Progress, Badge, LinkButton, Status } from "@/components/ui";
import { OwnerSections } from "./_components/OwnerSections";

const MIS_ROLES = ["MD", "FINANCE_HEAD", "SALES_HEAD", "GM_PROJECTS"];

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await requireUser();
  const snaps = await projectSnapshot(user.projectIds);
  const first = user.name.split(" ")[0];

  // Personal work queue for everyone
  const leadWhere = user.role === "SALES_EXEC" ? { ownerId: user.id } : user.projectIds === "ALL" ? {} : { projectId: { in: user.projectIds } };
  const seesLeads = SALES_ROLES.includes(user.role);
  const freshLeads = seesLeads ? await db.lead.findMany({ where: { ...leadWhere, firstCallAt: null, stage: "NEW" }, orderBy: { createdAt: "asc" }, take: 50 }) : [];
  const escalated = freshLeads.filter((l) => needsEscalation(l));
  const followUps = seesLeads ? await db.lead.count({ where: { ...leadWhere, nextFollowUp: { lte: new Date(new Date().setHours(23, 59, 59)) }, stage: { notIn: ["LOST", "BOOKED", "AGREEMENT_SIGNED"] } } }) : 0;
  const rules = await db.approvalRule.findMany({ where: { role: user.role } });
  const openReqs = await db.approvalRequest.findMany({ where: { status: "PENDING", requestedById: { not: user.id } }, select: { action: true, currentLevel: true } });
  const myApprovals = openReqs.filter((r) => rules.some((x) => x.action === r.action && x.level === r.currentLevel)).length;
  const budgetHolds = await db.purchaseOrder.count({ where: { status: "BUDGET_HOLD", ...(user.projectIds === "ALL" ? {} : { projectId: { in: user.projectIds } }) } });

  const showMis = MIS_ROLES.includes(user.role);
  const tot = snaps.reduce(
    (a, s) => ({
      booked: a.booked + s.units.booked, units: a.units + s.units.total, value: a.value + s.salesValue,
      demanded: a.demanded + s.demanded, collected: a.collected + s.collected, overdue: a.overdue + s.overdue,
      budget: a.budget + s.budget.total, committed: a.committed + s.budget.committed, actual: a.actual + s.budget.actual,
      delayed: a.delayed + s.schedule.delayed.length, b30: a.b30 + s.bookings30,
    }),
    { booked: 0, units: 0, value: 0, demanded: 0, collected: 0, overdue: 0, budget: 0, committed: 0, actual: 0, delayed: 0, b30: 0 },
  );

  return (
    <>
      <PageHeader eyebrow={`${ROLE_LABEL[user.role] ?? user.role} · ${date(new Date())}`} title={`Good day, ${first}.`}>
        {showMis && <LinkButton href="/reports/board-pack" variant="secondary">Board pack</LinkButton>}
      </PageHeader>

      {/* Today's attention list */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AttentionTile href="/approvals" label="Waiting for your approval" value={myApprovals} tone={myApprovals ? "warn" : undefined} />
        {seesLeads && <AttentionTile href="/sales/leads?filter=firstcall" label="Leads past 15 minutes without a call" value={escalated.length} tone={escalated.length ? "bad" : undefined} />}
        {seesLeads && <AttentionTile href="/sales/leads?filter=followups" label="Follow-ups due today" value={followUps} />}
        {showMis && <AttentionTile href="/cost/orders" label="Orders held for budget" value={budgetHolds} tone={budgetHolds ? "bad" : undefined} />}
        {showMis && <AttentionTile href="/projects/schedule" label="Milestones behind plan" value={tot.delayed} tone={tot.delayed ? "warn" : undefined} />}
      </div>

      {showMis && (
        <>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Units booked" value={`${tot.booked} / ${tot.units}`} sub={`${tot.b30} booked in the last 30 days`} />
            <Stat label="Sales value" value={inr(tot.value)} sub="Agreement value of active bookings" />
            <Stat label="Collected" value={inr(tot.collected)} sub={`${pct(tot.collected, tot.demanded)}% of ${inr(tot.demanded)} demanded`} tone={pct(tot.collected, tot.demanded) < 80 ? "warn" : "good"} />
            <Stat label="Overdue from buyers" value={inr(tot.overdue)} sub="Past due date, unpaid" tone={tot.overdue ? "bad" : "good"} />
          </div>

          <OwnerSections projectIds={user.projectIds} />

          <Card title="Projects at a glance" pad={false} className="mb-8">
            <Table head={["Project", "Units sold", { label: "Sales value", num: true }, "Collections", "Budget used (committed)", { label: "Actual spend", num: true }, "Schedule"]}>
              {snaps.map((s) => {
                const used = pct(s.budget.committed, s.budget.total);
                return (
                  <tr key={s.project.id}>
                    <td><p className="font-medium">{s.project.name}</p><p className="text-xs text-stone">{s.project.location}</p></td>
                    <td className="min-w-36">
                      <p>{s.units.booked} of {s.units.total} <span className="text-stone">({pct(s.units.booked, s.units.total)}%)</span></p>
                      <div className="mt-1.5"><Progress value={pct(s.units.booked, s.units.total)} /></div>
                    </td>
                    <td className="num">{inr(s.salesValue)}</td>
                    <td className="min-w-40">
                      <p>{inr(s.collected)} <span className="text-stone">of {inr(s.demanded)}</span></p>
                      {s.overdue > 0 && <p className="text-xs text-bad">{inr(s.overdue)} overdue</p>}
                    </td>
                    <td className="min-w-44">
                      <p>{inr(s.budget.committed)} <span className="text-stone">of {inr(s.budget.total)}</span></p>
                      <div className="mt-1.5"><Progress value={used} tone={used > 95 ? "bad" : used > 85 ? "warn" : undefined} /></div>
                    </td>
                    <td className="num">{inr(s.budget.actual)}</td>
                    <td className="min-w-48">
                      {s.schedule.current.slice(0, 2).map((m) => (
                        <p key={m.id} className="flex items-center gap-2 text-xs">
                          <span>{m.name}</span>
                          {m.plannedEnd.getTime() < Date.now() - 3 * 864e5 ? <Badge tone="bad">Late</Badge> : <span className="text-stone">{m.progressPct}%</span>}
                        </p>
                      ))}
                      {s.schedule.current.length === 0 && <span className="text-xs text-stone">Not started</span>}
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Budget lines closest to the limit" pad={false}>
              <Table head={["Project", "Cost head", "Used", { label: "Available", num: true }]}>
                {snaps.flatMap((s) => s.budget.rows.map((r) => ({ ...r, project: s.project.name })))
                  .sort((a, b) => b.usedPct - a.usedPct).slice(0, 6)
                  .map((r) => (
                    <tr key={r.lineId}>
                      <td>{r.project}</td>
                      <td>{r.name}</td>
                      <td className="min-w-32"><span className={r.usedPct > 95 ? "text-bad" : ""}>{r.usedPct}%</span><div className="mt-1"><Progress value={r.usedPct} tone={r.usedPct > 95 ? "bad" : r.usedPct > 85 ? "warn" : undefined} /></div></td>
                      <td className="num">{inr(r.available)}</td>
                    </tr>
                  ))}
              </Table>
            </Card>
            <Card title="Milestones behind plan" pad={false}>
              <Table head={["Milestone", "Planned finish", "Progress", ""]} empty="Every milestone is on plan.">
                {snaps.flatMap((s) => s.schedule.delayed).map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{date(m.plannedEnd)} <span className="text-xs text-bad">({Math.round((Date.now() - m.plannedEnd.getTime()) / 864e5)} days late)</span></td>
                    <td>{m.progressPct}%</td>
                    <td><Status value={m.status} /></td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        </>
      )}

      {!showMis && snaps.length > 0 && (
        <Card title="Your projects" pad={false}>
          <Table head={["Project", "Units available", "Units booked", "Current milestone"]}>
            {snaps.map((s) => (
              <tr key={s.project.id}>
                <td className="font-medium">{s.project.name}</td>
                <td>{s.units.available}</td>
                <td>{s.units.booked}</td>
                <td>{s.schedule.current[0]?.name ?? "–"} {s.schedule.current[0] && <span className="text-stone">({s.schedule.current[0].progressPct}%)</span>}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {escalated.length > 0 && (
        <Card title="Call these buyers now" className="mt-8" pad={false}>
          <Table head={["Buyer", "Source", "Waiting"]}>
            {escalated.slice(0, 8).map((l) => (
              <tr key={l.id}>
                <td><Link href={`/sales/leads/${l.id}`} className="font-medium hover:underline">{l.name}</Link></td>
                <td>{l.source}</td>
                <td className="text-bad">{Math.round((Date.now() - l.createdAt.getTime()) / 60000)} min</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

function AttentionTile({ href, label, value, tone }: { href: string; label: string; value: number; tone?: "warn" | "bad" }) {
  return (
    <Link href={href} className="group rounded-xl border border-line bg-panel p-5 transition-colors hover:border-stone">
      <p className={`font-serif text-4xl leading-none ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : ""}`}>{value}</p>
      <p className="mt-2 text-sm text-ink-2">{label}</p>
    </Link>
  );
}
