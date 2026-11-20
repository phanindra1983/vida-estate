import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, can, projectScope } from "@/lib/auth";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { date, num } from "@/lib/format";
import { userNames } from "@/lib/cost";
import { PageHeader, Card, Table, Status, Field, Button } from "@/components/ui";
import { Flash } from "../../projects/_components/Flash";
import { createRequest, decideRequest } from "../actions";

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(PROCUREMENT_ROLES);
  const sp = await searchParams;
  const requests = await db.materialRequest.findMany({
    where: projectScope(user),
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { project: { select: { name: true } }, costCode: true, _count: { select: { quotes: true } } },
  });
  const names = await userNames(requests.map((r) => r.requestedById));
  const canRaise = can(user, ["SITE_ENGINEER", "PROJECT_MANAGER", "STOREKEEPER"]);
  const canDecide = can(user, ["PROJECT_MANAGER", "GM_PROJECTS"]);
  const projects = canRaise
    ? await db.project.findMany({ where: user.projectIds === "ALL" ? {} : { id: { in: user.projectIds } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } })
    : [];
  const codes = canRaise ? await db.costCode.findMany({ orderBy: { code: "asc" } }) : [];

  return (
    <>
      <PageHeader eyebrow="Cost" title="Material requests" />
      <Flash sp={sp} />
      <div className={`grid gap-6 ${canRaise ? "lg:grid-cols-[1fr_22rem]" : ""}`}>
        <Card pad={false}>
          <Table head={["Request", "Project", "Item", { label: "Qty", num: true }, "Needed by", "Raised by", "Status", ""]} empty="No material requests yet.">
            {requests.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap"><Link href={`/cost/requests/${r.id}`} className="font-medium underline-offset-4 hover:underline">{r.number}</Link></td>
                <td>{r.project.name}</td>
                <td>{r.item}<div className="text-xs text-stone">{r.costCode.name}</div></td>
                <td className="num whitespace-nowrap">{num(r.qty, 2)} {r.unit}</td>
                <td className="whitespace-nowrap">{date(r.neededBy)}</td>
                <td>{names.get(r.requestedById) ?? "–"}</td>
                <td>
                  <Status value={r.status} />
                  {r.status === "APPROVED" && <div className="mt-1 text-xs text-stone">{r._count.quotes} of 3 quotes</div>}
                </td>
                <td>
                  {canDecide && r.status === "SUBMITTED" && r.requestedById !== user.id && (
                    <div className="flex gap-2">
                      {(["APPROVED", "REJECTED"] as const).map((d) => (
                        <form key={d} action={decideRequest}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="decision" value={d} />
                          <Button size="sm" variant={d === "APPROVED" ? "primary" : "danger"}>{d === "APPROVED" ? "Approve" : "Reject"}</Button>
                        </form>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        {canRaise && (
          <Card title="Raise a request">
            <form action={createRequest} className="grid gap-4">
              <Field label="Project">
                <select name="projectId" className="input" required>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </Field>
              <Field label="Cost head">
                <select name="costCodeId" className="input" required>{codes.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select>
              </Field>
              <Field label="Item"><input name="item" className="input" required placeholder="e.g. TMT steel Fe550D, 12 mm" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Quantity"><input name="qty" type="number" step="any" min={0} inputMode="decimal" className="input" required /></Field>
                <Field label="Unit"><input name="unit" className="input" required placeholder="MT, bags, cum" /></Field>
              </div>
              <Field label="Needed by"><input name="neededBy" type="date" className="input" required /></Field>
              <Field label="Note"><textarea name="note" rows={2} className="input" /></Field>
              <Button>Raise request</Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
