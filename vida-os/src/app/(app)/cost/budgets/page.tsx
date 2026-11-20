import { db } from "@/lib/db";
import { requireUser, can } from "@/lib/auth";
import { COST_ROLES } from "@/lib/constants";
import { inr, date } from "@/lib/format";
import { budgetPosition } from "@/lib/mis";
import { PageHeader, Card, Stat, Table, Progress, Badge, Status, Field, Button } from "@/components/ui";
import { Flash } from "../../projects/_components/Flash";
import { ProjectTabs } from "../../projects/_components/ProjectTabs";
import { requestRevision } from "../actions";

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ project?: string; ok?: string; error?: string }> }) {
  const user = await requireUser(COST_ROLES);
  const sp = await searchParams;
  const projects = await db.project.findMany({
    where: user.projectIds === "ALL" ? {} : { id: { in: user.projectIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const current = projects.find((p) => p.id === sp.project) ?? projects[0];
  if (!current) return <PageHeader eyebrow="Cost" title="Budgets" />;

  const rows = await budgetPosition(current.id);
  const revisions = await db.budgetRevision.findMany({
    where: { line: { projectId: current.id } },
    include: { line: { include: { costCode: true } } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const pendingBy = new Map(revisions.filter((r) => r.status === "PENDING").map((r) => [r.budgetLineId, r.newAmount]));
  const total = rows.reduce((s, r) => s + r.budget, 0);
  const committed = rows.reduce((s, r) => s + r.committed, 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  const over = rows.filter((r) => r.committed > r.budget).length;
  const canRevise = can(user, ["PROJECT_MANAGER", "PURCHASE", "ACCOUNTS"]);
  const back = `/cost/budgets?project=${current.id}`;

  return (
    <>
      <PageHeader eyebrow="Cost" title="Budgets" />
      <ProjectTabs base="/cost/budgets" projects={projects} current={current.id} />
      <Flash sp={sp} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Budget" value={inr(total)} sub={current.name} />
        <Stat label="Committed" value={inr(committed)} sub={`${total ? Math.round((committed / total) * 100) : 0}% of budget`} tone={committed > total ? "bad" : undefined} />
        <Stat label="Actual (bills)" value={inr(actual)} sub={`${total ? Math.round((actual / total) * 100) : 0}% of budget`} />
        <Stat label="Lines over budget" value={over} sub={over ? "New POs on these lines will wait for a revision" : "All lines within budget"} tone={over ? "bad" : "good"} />
      </div>

      <Card title="Budget vs committed vs actual" pad={false} className="mb-6">
        <Table head={["Cost head", { label: "Budget", num: true }, { label: "Committed", num: true }, { label: "Actual", num: true }, { label: "Available", num: true }, "Used"]}>
          {rows.map((r) => {
            const hot = r.usedPct > 95;
            return (
              <tr key={r.lineId}>
                <td>
                  <span className="text-stone">{r.code}</span> {r.name}
                  {pendingBy.has(r.lineId) && <span className="ml-2"><Badge tone="warn">Revision to {inr(pendingBy.get(r.lineId)!)} pending</Badge></span>}
                </td>
                <td className="num">{inr(r.budget)}</td>
                <td className="num">{inr(r.committed)}</td>
                <td className="num">{inr(r.actual)}</td>
                <td className={`num ${r.available < 0 ? "text-bad" : ""}`}>{inr(r.available)}</td>
                <td className="min-w-36">
                  <div className="mb-1 text-right text-xs">{r.usedPct}%</div>
                  <Progress value={r.usedPct} tone={hot ? "bad" : r.usedPct > 80 ? "warn" : undefined} />
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        {canRevise && (
          <Card title="Request a budget revision">
            <form action={requestRevision} className="grid gap-4">
              <input type="hidden" name="back" value={back} />
              <Field label="Cost head">
                <select name="lineId" className="input" required>
                  {rows.map((r) => <option key={r.lineId} value={r.lineId}>{r.code} {r.name} (now {inr(r.budget)})</option>)}
                </select>
              </Field>
              <Field label="New budget (₹)" hint="Whole rupees, e.g. 150000000 for ₹15 Cr"><input name="newAmount" type="number" min={1} className="input" required /></Field>
              <Field label="Reason"><textarea name="reason" rows={2} className="input" required /></Field>
              <Button>Send for approval</Button>
            </form>
          </Card>
        )}
        <Card title="Recent revisions" pad={false}>
          <Table head={["Cost head", { label: "From", num: true }, { label: "To", num: true }, "Reason", "Status"]} empty="No revisions yet.">
            {revisions.map((r) => (
              <tr key={r.id}>
                <td>{r.line.costCode.name}<div className="text-xs text-stone">{date(r.createdAt)}</div></td>
                <td className="num">{inr(r.oldAmount)}</td>
                <td className="num">{inr(r.newAmount)}</td>
                <td className="text-xs">{r.reason}</td>
                <td><Status value={r.status} /></td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
