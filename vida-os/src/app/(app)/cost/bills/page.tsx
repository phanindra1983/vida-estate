import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, can, projectScope } from "@/lib/auth";
import { FINANCE_ROLES, MATCH_TOLERANCE_PCT } from "@/lib/constants";
import { date, inr, num } from "@/lib/format";
import { PageHeader, Card, Table, Status, Field, Button, Stat } from "@/components/ui";
import { Flash } from "../../projects/_components/Flash";
import { enterBill, billAction } from "../actions";

export default async function BillsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(FINANCE_ROLES);
  const sp = await searchParams;
  const scope = projectScope(user);
  const bills = await db.vendorBill.findMany({
    where: { po: scope },
    orderBy: { createdAt: "desc" },
    take: 150,
    include: { vendor: { select: { name: true } }, po: { select: { number: true, rate: true, unit: true, project: { select: { name: true } } } } },
  });
  const canEnter = can(user, ["ACCOUNTS", "FINANCE_HEAD"]);
  const isHead = can(user, ["FINANCE_HEAD"]);
  const isAccounts = can(user, ["ACCOUNTS"]);
  const pos = canEnter
    ? await db.purchaseOrder.findMany({
        where: { ...scope, receipts: { some: {} } },
        orderBy: { createdAt: "desc" },
        include: { receipts: { select: { qty: true } }, bills: { select: { qty: true } }, vendor: { select: { name: true } } },
      })
    : [];
  const billable = pos
    .map((p) => ({ ...p, open: p.receipts.reduce((s, r) => s + r.qty, 0) - p.bills.reduce((s, b) => s + b.qty, 0) }))
    .filter((p) => p.open > 0);

  const sum = (s: string[]) => bills.filter((b) => s.includes(b.status)).reduce((a, b) => a + b.amount, 0);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader eyebrow="Cost" title="Vendor bills" />
      <Flash sp={sp} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="On hold" value={inr(sum(["ON_HOLD"]))} sub={`${bills.filter((b) => b.status === "ON_HOLD").length} bills need a decision`} tone={sum(["ON_HOLD"]) ? "bad" : undefined} />
        <Stat label="To check" value={inr(sum(["ENTERED"]))} sub="Matched, not yet payable" />
        <Stat label="Payable" value={inr(sum(["PAYABLE"]))} sub="Ready to send for payment" />
        <Stat label="In payment approval" value={inr(sum(["IN_PAYMENT"]))} sub="Waiting for the checker" tone="warn" />
      </div>

      <div className={`grid gap-6 ${canEnter ? "xl:grid-cols-[1fr_22rem]" : ""}`}>
        <Card pad={false}>
          <Table head={["Bill", "Vendor", "PO", { label: "Qty × rate", num: true }, { label: "Amount", num: true }, "Three-way match", "Status", ""]} empty="No vendor bills yet.">
            {bills.map((b) => (
              <tr key={b.id}>
                <td className="whitespace-nowrap font-medium">{b.billNo}<div className="text-xs font-normal text-stone">{date(b.billDate)}</div></td>
                <td>{b.vendor.name}<div className="text-xs text-stone">{b.po.project.name}</div></td>
                <td className="whitespace-nowrap"><Link href={`/cost/orders/${b.poId}`} className="underline-offset-4 hover:underline">{b.po.number}</Link></td>
                <td className="num whitespace-nowrap">{num(b.qty, 2)} {b.po.unit} × ₹{num(b.rate, 2)}<div className="text-xs text-stone">PO rate ₹{num(b.po.rate, 2)}</div></td>
                <td className="num">{inr(b.amount)}</td>
                <td className="max-w-60"><Status value={b.match} />{b.matchNote && <p className="mt-1 text-xs text-bad">{b.matchNote}</p>}</td>
                <td><Status value={b.status} />{b.paidAt && <div className="mt-1 text-xs text-stone">Paid {date(b.paidAt)}</div>}</td>
                <td className="min-w-40">
                  {isHead && b.status === "ON_HOLD" && (
                    <form action={billAction} className="grid gap-2">
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="op" value="resolve" />
                      <input name="comment" className="input !min-h-9 text-xs" placeholder="Why it is acceptable" required />
                      <Button size="sm" variant="secondary">Resolve and accept</Button>
                    </form>
                  )}
                  {isHead && b.status === "ENTERED" && b.match === "MATCHED" && (
                    <form action={billAction}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="op" value="payable" /><Button size="sm" variant="secondary">Mark payable</Button></form>
                  )}
                  {isAccounts && b.status === "PAYABLE" && (
                    <form action={billAction}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="op" value="send" /><Button size="sm">Send for payment</Button></form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        {canEnter && (
          <Card title="Enter a vendor bill">
            {billable.length === 0 ? (
              <p className="text-sm text-stone">No received goods are waiting to be billed.</p>
            ) : (
              <form action={enterBill} className="grid gap-4">
                <Field label="Purchase order" hint="Only POs with received goods not yet billed.">
                  <select name="poId" className="input" required>
                    {billable.map((p) => <option key={p.id} value={p.id}>{p.number} · {p.vendor.name} · {num(p.open, 2)} {p.unit} to bill at ₹{num(p.rate, 2)}</option>)}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Bill no."><input name="billNo" className="input" required /></Field>
                  <Field label="Bill date"><input name="billDate" type="date" defaultValue={today} className="input" required /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Quantity"><input name="qty" type="number" step="any" min={0} className="input" required /></Field>
                  <Field label="Rate (₹)"><input name="rate" type="number" step="any" min={0} className="input" required /></Field>
                </div>
                <Field label="TDS %"><input name="tdsPct" type="number" step="any" min={0} defaultValue={1} className="input" /></Field>
                <p className="text-xs text-stone">The bill is checked against the PO and goods received. Quantity must not exceed what was received, and the rate must be within {MATCH_TOLERANCE_PCT}% of the PO rate, or the bill goes on hold.</p>
                <Button>Enter bill</Button>
              </form>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
