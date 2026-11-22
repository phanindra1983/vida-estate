import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { datetime, ago } from "@/lib/format";
import { PageHeader, Card, Button, Field, Table } from "@/components/ui";
import { syncOpenCalls, INTEREST, talkedWhere } from "@/lib/bolna";
import { Flash, one, type SP } from "../../_ui";
import { CALL_ROLES, CALL_MANAGERS, CallTabs, callScope, TRIGGER, CallResult, Conversation, mins, masked, dollars } from "../_shared";

export const dynamic = "force-dynamic";

const RESULTS: Record<string, { label: string; where: Prisma.AiCallWhereInput }> = {
  talked: { label: "Talked to the buyer", where: talkedWhere },
  interested: { label: "Interested", where: { interest: "INTERESTED" } },
  visit: { label: "Site visit agreed", where: { visitNote: { not: null } } },
  callback: { label: "Call back later", where: { interest: "CALL_BACK" } },
  noanswer: { label: "No answer or busy", where: { status: { in: ["no-answer", "busy"] } } },
  failed: { label: "Failed", where: { status: { in: ["failed", "error", "FAILED_TO_START", "balance-low"] } } },
  dnc: { label: "Asked not to call", where: { interest: "DO_NOT_CALL" } },
};

export default async function CallHistoryPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(CALL_ROLES);
  const sp = await searchParams;
  await syncOpenCalls(15);
  const days = Number(one(sp.days) ?? 30) || 0;
  const projectId = one(sp.projectId) ?? "";
  const result = one(sp.result) ?? "";
  const trigger = one(sp.trigger) ?? "";
  const by = one(sp.by) ?? "";
  const isManager = CALL_MANAGERS.includes(u.role);

  const and: Prisma.AiCallWhereInput[] = [callScope(u)];
  if (days) and.push({ createdAt: { gt: new Date(Date.now() - days * 864e5) } });
  if (projectId) and.push({ projectId });
  if (RESULTS[result]) and.push(RESULTS[result].where);
  if (trigger in TRIGGER) and.push({ trigger });
  if (by && isManager) and.push({ startedById: by });

  const [calls, total, projects, people] = await Promise.all([
    db.aiCall.findMany({ where: { AND: and }, orderBy: { createdAt: "desc" }, take: 200, include: { lead: { select: { id: true, name: true, ownerId: true } }, campaign: { select: { name: true } } } }),
    db.aiCall.aggregate({ where: { AND: and }, _count: true, _sum: { costCents: true, durationSec: true } }),
    db.project.findMany({ where: projectScope(u).projectId ? { id: projectScope(u).projectId } : {}, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    isManager ? db.user.findMany({ where: { role: { in: ["MD", "SALES_HEAD", "SALES_MANAGER", "SALES_EXEC", "MARKETING"] }, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
  ]);
  const names = new Map(people.map((p) => [p.id, p.name]));

  return (
    <>
      <PageHeader eyebrow="Sales · AI call centre" title="Call history" />
      <CallTabs active="/sales/calls/history" role={u.role} />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />

      <form className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
        <Field label="Period">
          <select className="input" name="days" defaultValue={String(days)}>
            <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="0">All time</option>
          </select>
        </Field>
        <Field label="Project">
          <select className="input" name="projectId" defaultValue={projectId}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Result">
          <select className="input" name="result" defaultValue={result}>
            <option value="">Any result</option>
            {Object.entries(RESULTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Why called">
          <select className="input" name="trigger" defaultValue={trigger}>
            <option value="">Any</option>
            {Object.entries(TRIGGER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {isManager ? (
          <Field label="Asked by">
            <select className="input" name="by" defaultValue={by}>
              <option value="">Anyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        ) : <div />}
        <Button variant="secondary">Show</Button>
      </form>

      <p className="mb-3 text-sm text-stone">
        {total._count} calls{total._count > 200 ? " (latest 200 shown)" : ""} · {mins(total._sum.durationSec ?? 0)} talking{isManager ? ` · cost ${dollars(total._sum.costCents ?? 0)}` : ""}
      </p>
      <Card pad={false}>
        <Table head={["When", "Buyer", "Why", "Result", "Talked", "Recording and conversation"]} empty="No calls match.">
          {calls.map((c) => (
            <tr key={c.id} className="align-top">
              <td className="whitespace-nowrap">{datetime(c.createdAt)}<p className="text-xs text-stone">{ago(c.createdAt)}</p></td>
              <td>
                {c.lead ? <Link className="underline underline-offset-4" href={`/sales/leads/${c.lead.id}`}>{c.lead.name}</Link> : <span className="text-stone">{masked(c.toNumber)}</span>}
                {isManager && c.startedById && names.get(c.startedById) && <p className="text-xs text-stone">by {names.get(c.startedById)}</p>}
              </td>
              <td>{TRIGGER[c.trigger] ?? c.trigger}{c.campaign && <p className="text-xs text-stone">{c.campaign.name}</p>}</td>
              <td><CallResult status={c.status} interest={c.interest} visitNote={c.visitNote} />{c.error && <p className="mt-1 max-w-48 text-xs text-stone">{c.error}</p>}</td>
              <td className="whitespace-nowrap">{mins(c.durationSec)}</td>
              <td><Conversation summary={c.summary} transcript={c.transcript} recordingId={c.recordingUrl ? c.id : null} /></td>
            </tr>
          ))}
        </Table>
      </Card>
      <p className="mt-3 text-xs text-stone">Results like {Object.values(INTEREST).slice(0, 3).map((i) => i.label).join(", ")} are worked out by Bolna from each conversation. Check the recording when it matters.</p>
    </>
  );
}
