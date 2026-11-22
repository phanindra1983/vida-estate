import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader, Card, Stat, Table, Field, Button } from "@/components/ui";
import { INTEREST, talkedWhere } from "@/lib/bolna";
import { one, type SP } from "../../_ui";
import { CALL_MANAGERS, CallTabs, callScope, TRIGGER, mins, dollars } from "../_shared";

export const dynamic = "force-dynamic";

type Row = { key: string; label: string; calls: number; talked: number; interested: number; visits: number; seconds: number; cents: number };

async function breakdown(base: Prisma.AiCallWhereInput[], by: "projectId" | "trigger" | "startedById", label: (k: string | null) => string): Promise<Row[]> {
  const where = { AND: base };
  const [all, talked, interested, visits] = await Promise.all([
    db.aiCall.groupBy({ by: [by], where, _count: true, _sum: { durationSec: true, costCents: true } }),
    db.aiCall.groupBy({ by: [by], where: { AND: [...base, talkedWhere] }, _count: true }),
    db.aiCall.groupBy({ by: [by], where: { AND: [...base, { interest: "INTERESTED" }] }, _count: true }),
    db.aiCall.groupBy({ by: [by], where: { AND: [...base, { visitNote: { not: null } }] }, _count: true }),
  ]);
  const count = (list: { _count: number }[], k: unknown) => (list as unknown as Record<string, unknown>[]).find((r) => r[by] === k)?._count as number ?? 0;
  return all
    .map((r) => {
      const k = (r as unknown as Record<string, string | null>)[by];
      return { key: k ?? "none", label: label(k), calls: r._count, talked: count(talked, k), interested: count(interested, k), visits: count(visits, k), seconds: r._sum.durationSec ?? 0, cents: r._sum.costCents ?? 0 };
    })
    .sort((a, b) => b.calls - a.calls);
}

function Breakdown({ title, rows, showCost }: { title: string; rows: Row[]; showCost: boolean }) {
  return (
    <Card title={title} pad={false}>
      <Table head={["", { label: "Calls", num: true }, { label: "Talked", num: true }, { label: "Interested", num: true }, { label: "Visits", num: true }, { label: "Talk time", num: true }, ...(showCost ? [{ label: "Cost", num: true }] : [])]} empty="No calls in this period.">
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="font-medium">{r.label}</td>
            <td className="text-right">{r.calls}</td>
            <td className="text-right">{r.talked}{r.calls ? <span className="text-xs text-stone"> ({Math.round((r.talked / r.calls) * 100)}%)</span> : null}</td>
            <td className="text-right">{r.interested}</td>
            <td className="text-right">{r.visits}</td>
            <td className="text-right">{mins(r.seconds)}</td>
            {showCost && <td className="text-right">{dollars(r.cents)}</td>}
          </tr>
        ))}
      </Table>
    </Card>
  );
}

export default async function CallReportsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser([...CALL_MANAGERS, "MARKETING"]);
  const sp = await searchParams;
  const days = Number(one(sp.days) ?? 30) || 30;
  const showCost = CALL_MANAGERS.includes(u.role);
  const base: Prisma.AiCallWhereInput[] = [callScope(u), { createdAt: { gt: new Date(Date.now() - days * 864e5) } }, { trigger: { not: "TEST" } }];

  const [projects, users] = await Promise.all([
    db.project.findMany({ select: { id: true, name: true } }),
    db.user.findMany({ select: { id: true, name: true } }),
  ]);
  const pName = new Map(projects.map((p) => [p.id, p.name]));
  const uName = new Map(users.map((x) => [x.id, x.name]));

  const [total, talked, byInterest, visits, byProject, byTrigger, byPerson] = await Promise.all([
    db.aiCall.aggregate({ where: { AND: base }, _count: true, _sum: { durationSec: true, costCents: true } }),
    db.aiCall.count({ where: { AND: [...base, talkedWhere] } }),
    db.aiCall.groupBy({ by: ["interest"], where: { AND: [...base, { interest: { not: null } }] }, _count: true }),
    db.aiCall.count({ where: { AND: [...base, { visitNote: { not: null } }] } }),
    breakdown(base, "projectId", (k) => (k ? pName.get(k) ?? "Project" : "No project")),
    breakdown(base, "trigger", (k) => TRIGGER[k ?? ""] ?? k ?? "–"),
    breakdown(base, "startedById", (k) => (k ? uName.get(k) ?? "Someone" : "Automatic (new leads)")),
  ]);
  const interested = byInterest.find((r) => r.interest === "INTERESTED")?._count ?? 0;
  const cents = total._sum.costCents ?? 0;

  return (
    <>
      <PageHeader eyebrow="Sales · AI call centre" title="Reports" />
      <CallTabs active="/sales/calls/reports" role={u.role} />

      <form className="mb-6 flex items-end gap-3">
        <Field label="Period">
          <select className="input" name="days" defaultValue={String(days)}>
            <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option>
          </select>
        </Field>
        <Button variant="secondary">Show</Button>
      </form>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="AI calls" value={total._count} sub={`${mins(total._sum.durationSec ?? 0)} talking`} />
        <Stat label="Talked to a buyer" value={talked} sub={total._count ? `${Math.round((talked / total._count) * 100)}% answered and spoke` : "–"} />
        <Stat label="Interested buyers" value={interested} tone={interested ? "good" : undefined} sub={talked ? `${Math.round((interested / talked) * 100)}% of conversations` : "–"} />
        <Stat label="Site visits agreed" value={visits} tone={visits ? "good" : undefined} />
        {showCost ? <Stat label="Cost" value={dollars(cents)} sub={interested ? `${dollars(cents / interested)} per interested buyer` : "Bolna charges per minute"} /> : <Stat label="Conversations" value={talked} />}
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card title="What buyers said" pad={false}>
          <Table head={["Result", { label: "Calls", num: true }]} empty="No results yet. Results appear once call outcomes are switched on.">
            {Object.entries(INTEREST).map(([k, v]) => {
              const n = byInterest.find((r) => r.interest === k)?._count ?? 0;
              return n ? <tr key={k}><td>{v.label}</td><td className="text-right">{n}</td></tr> : null;
            })}
          </Table>
        </Card>
        <Breakdown title="By project" rows={byProject} showCost={showCost} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Breakdown title="By reason for the call" rows={byTrigger} showCost={showCost} />
        <Breakdown title="By who asked for the call" rows={byPerson} showCost={showCost} />
      </div>
    </>
  );
}
