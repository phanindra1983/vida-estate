import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { decide } from "@/lib/approvals";
import { APPROVAL_ACTIONS, ROLE_LABEL } from "@/lib/constants";
import { inr, ago, datetime } from "@/lib/format";
import { PageHeader, Card, Table, Badge, Status, Button, Notice } from "@/components/ui";

const LINK: Record<string, (id: string) => string> = {
  PurchaseOrder: (id) => `/cost/orders/${id}`,
  BudgetRevision: () => `/cost/budgets`,
  VendorBill: () => `/cost/bills`,
  Payout: () => `/sales/payouts`,
  Milestone: () => `/projects/schedule`,
  Booking: (id) => `/sales/bookings/${id}`,
  Rfq: (id) => `/procurement/rfq/${id}`,
};

async function act(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("id"));
  const decision = formData.get("decision") === "REJECTED" ? "REJECTED" : "APPROVED";
  const comment = String(formData.get("comment") || "").trim();
  if (decision === "REJECTED" && !comment) redirect(`/approvals?err=${encodeURIComponent("Please add a reason when rejecting.")}`);
  let result = "";
  try {
    result = await decide(id, user, decision, comment);
  } catch (e) {
    redirect(`/approvals?err=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/", "layout");
  const msg = result === "NEXT_LEVEL" ? "Approved at your level. It now waits for the next approver." : result === "APPROVED" ? "Final approval given. The request is now approved." : "Rejected. The person who raised it can see your reason.";
  redirect(`/approvals?ok=${encodeURIComponent(msg)}`);
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ err?: string; ok?: string; view?: string }> }) {
  const user = await requireUser();
  const { err, ok, view } = await searchParams;
  const scope = user.projectIds === "ALL" ? {} : { OR: [{ projectId: null }, { projectId: { in: user.projectIds } }] };

  const pending = await db.approvalRequest.findMany({ where: { status: "PENDING", ...scope }, include: { steps: { orderBy: { level: "asc" } } }, orderBy: { createdAt: "asc" } });
  const rules = await db.approvalRule.findMany();
  const roleFor = (r: { action: string; currentLevel: number }) => rules.find((x) => x.action === r.action && x.level === r.currentLevel)?.role;
  const mine = pending.filter((r) => roleFor(r) === user.role && r.requestedById !== user.id);
  const others = pending.filter((r) => !mine.includes(r));
  const decided = await db.approvalRequest.findMany({ where: { status: { not: "PENDING" }, ...scope }, orderBy: { decidedAt: "desc" }, take: 25 });
  const userIds = [...new Set([...pending, ...decided].map((r) => r.requestedById))];
  const names = Object.fromEntries((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

  return (
    <>
      <PageHeader eyebrow="Overview" title="Approvals" />
      <div className="mb-6 grid gap-3">
        {err && <Notice tone="bad">{err}</Notice>}
        {ok && <Notice tone="good">{ok}</Notice>}
      </div>

      <Card title={`Waiting for you (${mine.length})`} pad={false} className="mb-8">
        {mine.length === 0 ? (
          <p className="p-6 text-sm text-stone">Nothing needs your approval right now.</p>
        ) : (
          <ul className="divide-y divide-line">
            {mine.map((r) => (
              <li key={r.id} className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="brass">{APPROVAL_ACTIONS[r.action] ?? r.action}</Badge>
                    <span className="text-xs text-stone">Level {r.currentLevel} of {r.requiredLevel} · raised by {names[r.requestedById] ?? "System"} {ago(r.createdAt)}</span>
                  </div>
                  <Link href={LINK[r.entityType]?.(r.entityId) ?? "#"} className="mt-2 block font-medium hover:underline">{r.title}</Link>
                  {r.amount > 0 && <p className="mt-1 font-serif text-2xl">{inr(r.amount)}</p>}
                  {r.steps.length > 0 && (
                    <p className="mt-2 text-xs text-stone">
                      Already approved by: {r.steps.map((s) => ROLE_LABEL[s.role] ?? s.role).join(", ")}
                    </p>
                  )}
                </div>
                <form action={act} className="flex flex-wrap items-center gap-2 md:justify-end">
                  <input type="hidden" name="id" value={r.id} />
                  <input name="comment" placeholder="Comment (required to reject)" className="input md:w-56" />
                  <Button name="decision" value="APPROVED">Approve</Button>
                  <Button name="decision" value="REJECTED" variant="danger">Reject</Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`In progress with others (${others.length})`} pad={false} className="mb-8">
        <Table head={["Request", "Type", { label: "Amount", num: true }, "Waiting for", "Raised"]} empty="No other open requests.">
          {others.map((r) => (
            <tr key={r.id}>
              <td><Link href={LINK[r.entityType]?.(r.entityId) ?? "#"} className="hover:underline">{r.title}</Link></td>
              <td>{APPROVAL_ACTIONS[r.action] ?? r.action}</td>
              <td className="num">{r.amount ? inr(r.amount) : "–"}</td>
              <td>{ROLE_LABEL[roleFor(r) ?? ""] ?? roleFor(r)} <span className="text-stone">(level {r.currentLevel}/{r.requiredLevel})</span></td>
              <td className="text-stone">{ago(r.createdAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      {view !== "hide" && (
        <Card title="Recently decided" pad={false}>
          <Table head={["Request", "Type", { label: "Amount", num: true }, "Outcome", "Decided"]} empty="No decisions yet.">
            {decided.map((r) => (
              <tr key={r.id}>
                <td><Link href={LINK[r.entityType]?.(r.entityId) ?? "#"} className="hover:underline">{r.title}</Link></td>
                <td>{APPROVAL_ACTIONS[r.action] ?? r.action}</td>
                <td className="num">{r.amount ? inr(r.amount) : "–"}</td>
                <td><Status value={r.status} /></td>
                <td className="text-stone">{datetime(r.decidedAt)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
