import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, can, canSeeProject } from "@/lib/auth";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { date, inr, num } from "@/lib/format";
import { budgetPosition } from "@/lib/mis";
import { userNames } from "@/lib/cost";
import { PageHeader, Card, Table, Status, Badge, Field, Button, Notice } from "@/components/ui";
import { Flash } from "../../../projects/_components/Flash";
import { addQuote, createPoFromQuote, decideRequest } from "../../actions";

export default async function RequestDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(PROCUREMENT_ROLES);
  const { id } = await params;
  const sp = await searchParams;
  const mr = await db.materialRequest.findUnique({
    where: { id },
    include: { project: true, costCode: true, quotes: { include: { vendor: true } }, orders: true },
  });
  if (!mr || !canSeeProject(user, mr.projectId)) notFound();
  const names = await userNames([mr.requestedById]);
  const vendors = await db.vendor.findMany({ orderBy: { name: "asc" } });
  const line = (await budgetPosition(mr.projectId)).find((r) => r.costCodeId === mr.costCodeId);

  const quotes = mr.quotes
    .map((q) => ({ ...q, landed: Math.round(mr.qty * q.rate * (1 + q.gstPct / 100)) }))
    .sort((a, b) => a.landed - b.landed);
  const lowest = quotes[0]?.id;
  const isPurchase = can(user, ["PURCHASE"]);
  const canDecide = can(user, ["PROJECT_MANAGER", "GM_PROJECTS"]) && mr.status === "SUBMITTED" && mr.requestedById !== user.id;
  const enough = quotes.length >= 3;
  const quoted = new Set(mr.quotes.map((q) => q.vendorId));
  const back = `/cost/requests/${mr.id}`;

  return (
    <>
      <PageHeader eyebrow={`Cost · ${mr.project.name}`} title={mr.number}>
        <Status value={mr.status} />
      </PageHeader>
      <Flash sp={sp} />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <Card title="Request">
          <dl className="grid gap-3 text-sm">
            {([
              ["Item", mr.item],
              ["Quantity", `${num(mr.qty, 2)} ${mr.unit}`],
              ["Cost head", `${mr.costCode.code} ${mr.costCode.name}`],
              ["Needed by", date(mr.neededBy)],
              ["Raised by", `${names.get(mr.requestedById) ?? "–"}, ${date(mr.createdAt)}`],
              ["Note", mr.note ?? "–"],
              ["Budget left on this head", line ? inr(line.available) : "No budget line"],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[10rem_1fr] gap-3"><dt className="text-stone">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          {canDecide && (
            <div className="mt-5 flex gap-2">
              {(["APPROVED", "REJECTED"] as const).map((d) => (
                <form key={d} action={decideRequest}>
                  <input type="hidden" name="id" value={mr.id} />
                  <input type="hidden" name="decision" value={d} />
                  <input type="hidden" name="back" value={back} />
                  <Button variant={d === "APPROVED" ? "primary" : "danger"}>{d === "APPROVED" ? "Approve request" : "Reject"}</Button>
                </form>
              ))}
            </div>
          )}
          {mr.orders.length > 0 && (
            <p className="mt-5 text-sm">Ordered on {mr.orders.map((o) => <Link key={o.id} href={`/cost/orders/${o.id}`} className="underline underline-offset-4">{o.number}</Link>)}</p>
          )}
        </Card>

        <div className="grid gap-6">
          <Card title="Quote comparison" pad={false}>
            <form action={createPoFromQuote}>
              <input type="hidden" name="requestId" value={mr.id} />
              <Table head={["", "Vendor", { label: "Rate", num: true }, { label: "GST", num: true }, { label: "Delivery", num: true }, { label: "Landed cost", num: true }]} empty="No quotes yet.">
                {quotes.map((q) => (
                  <tr key={q.id} className={q.id === lowest ? "bg-[#f6f9f6]" : ""}>
                    <td>
                      {mr.status === "APPROVED" && isPurchase ? (
                        <input type="radio" name="quoteId" value={q.id} defaultChecked={q.id === lowest} aria-label={`Choose ${q.vendor.name}`} className="h-5 w-5 accent-[#121413]" />
                      ) : q.selected ? <Badge tone="good">Chosen</Badge> : null}
                    </td>
                    <td>{q.vendor.name}{q.id === lowest && <span className="ml-2"><Badge tone="good">Lowest</Badge></span>}<div className="text-xs text-stone">Rating {q.vendor.rating}/5</div></td>
                    <td className="num">₹{num(q.rate, 2)}/{mr.unit}</td>
                    <td className="num">{q.gstPct}%</td>
                    <td className="num">{q.deliveryDays} d</td>
                    <td className="num font-medium">{inr(q.landed)}</td>
                  </tr>
                ))}
              </Table>
              {mr.status === "APPROVED" && isPurchase && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
                  <p className="text-xs text-stone">{enough ? "If the PO goes over the budget left on this head, it waits for a budget revision first." : `Collect at least 3 quotes before ordering. ${quotes.length} so far.`}</p>
                  <Button disabled={!enough}>Create PO from selected quote</Button>
                </div>
              )}
            </form>
          </Card>

          {mr.status === "APPROVED" && isPurchase && (
            <Card title="Add a quote">
              <form action={addQuote} className="grid gap-4 sm:grid-cols-2">
                <input type="hidden" name="requestId" value={mr.id} />
                <div className="sm:col-span-2">
                  <Field label="Vendor">
                    <select name="vendorId" className="input" required>
                      {vendors.filter((v) => !quoted.has(v.id)).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.category}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label={`Rate (₹ per ${mr.unit})`}><input name="rate" type="number" step="any" min={0} className="input" required /></Field>
                <Field label="GST %"><input name="gstPct" type="number" step="any" min={0} defaultValue={18} className="input" required /></Field>
                <Field label="Delivery (days)"><input name="deliveryDays" type="number" min={0} className="input" required /></Field>
                <div className="flex items-end"><Button className="w-full">Add quote</Button></div>
              </form>
            </Card>
          )}
          {mr.status === "SUBMITTED" && <Notice tone="neutral">Waiting for the project manager or GM Projects to approve this request. Quotes can be collected after that.</Notice>}
        </div>
      </div>
    </>
  );
}
