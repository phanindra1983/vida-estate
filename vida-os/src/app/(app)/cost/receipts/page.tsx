import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, can, projectScope } from "@/lib/auth";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { date, num } from "@/lib/format";
import { userNames } from "@/lib/cost";
import { PageHeader, Card, Table, Field } from "@/components/ui";
import { Flash } from "../../projects/_components/Flash";
import { PhotoForm } from "../../projects/_components/PhotoForm";
import { receiveGoods } from "../actions";

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; po?: string }> }) {
  const user = await requireUser(PROCUREMENT_ROLES);
  const sp = await searchParams;
  const scope = projectScope(user);
  const receipts = await db.goodsReceipt.findMany({
    where: { po: scope },
    orderBy: { receivedAt: "desc" },
    take: 100,
    include: { po: { include: { project: { select: { name: true } }, vendor: { select: { name: true } } } } },
  });
  const names = await userNames(receipts.map((r) => r.receivedById));
  const canReceive = can(user, ["STOREKEEPER", "SITE_ENGINEER", "PROJECT_MANAGER"]);
  const open = canReceive
    ? await db.purchaseOrder.findMany({
        where: { ...scope, status: { in: ["APPROVED", "PARTLY_RECEIVED"] } },
        orderBy: { createdAt: "asc" },
        include: { project: { select: { name: true } }, receipts: { select: { qty: true } } },
      })
    : [];

  return (
    <>
      <PageHeader eyebrow="Cost" title="Goods received" />
      <Flash sp={sp} />
      <div className={`grid gap-6 ${canReceive ? "lg:grid-cols-[1fr_24rem]" : ""}`}>
        <Card pad={false}>
          <Table head={["GRN", "Date", "PO", "Item", { label: "Qty", num: true }, "Challan", "Received by"]} empty="Nothing received yet.">
            {receipts.map((g) => (
              <tr key={g.id}>
                <td className="whitespace-nowrap font-medium">{g.number}</td>
                <td className="whitespace-nowrap">{date(g.receivedAt)}</td>
                <td className="whitespace-nowrap"><Link href={`/cost/orders/${g.poId}`} className="underline-offset-4 hover:underline">{g.po.number}</Link><div className="text-xs text-stone">{g.po.project.name}</div></td>
                <td>{g.po.item}<div className="text-xs text-stone">{g.po.vendor.name}</div></td>
                <td className="num whitespace-nowrap">{num(g.qty, 2)} {g.po.unit}</td>
                <td>{g.photo ? <a href={g.photo} target="_blank" rel="noreferrer" className="underline underline-offset-4">{g.challanNo}</a> : g.challanNo}</td>
                <td>{names.get(g.receivedById) ?? "–"}</td>
              </tr>
            ))}
          </Table>
        </Card>

        {canReceive && (
          <Card title="Receive goods at site">
            {open.length === 0 ? (
              <p className="text-sm text-stone">No approved purchase orders are waiting for delivery.</p>
            ) : (
              <PhotoForm action={receiveGoods} photoName="challanPhoto" photoLabel="Photo of the delivery challan" multiple={false} submitLabel="Record receipt">
                <Field label="Purchase order">
                  <select name="poId" className="input" required defaultValue={sp.po ?? open[0].id}>
                    {open.map((o) => {
                      const due = o.qty - o.receipts.reduce((s, r) => s + r.qty, 0);
                      return <option key={o.id} value={o.id}>{o.number} · {o.item} · {num(due, 2)} {o.unit} due ({o.project.name})</option>;
                    })}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Quantity received"><input name="qty" type="number" step="any" min={0} inputMode="decimal" className="input" required /></Field>
                  <Field label="Challan no."><input name="challanNo" className="input" required /></Field>
                </div>
                <Field label="Note"><input name="note" className="input" placeholder="e.g. 2 bundles short, vehicle KA-01-1234" /></Field>
              </PhotoForm>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
