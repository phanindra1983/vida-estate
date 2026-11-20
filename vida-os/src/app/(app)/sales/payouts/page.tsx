import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { inr, date } from "@/lib/format";
import { PageHeader, Card, Table, Status, Button, Stat } from "@/components/ui";
import { sendPayoutForApproval, markPayoutPaid } from "../actions";
import { Flash, SubNav, one, type SP } from "../_ui";

export const dynamic = "force-dynamic";

const ROLES = ["MD", "SALES_HEAD", "FINANCE_HEAD", "ACCOUNTS"];

export default async function PayoutsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(ROLES);
  const sp = await searchParams;
  const status = one(sp.status) ?? "";
  const scope = u.projectIds === "ALL" ? {} : { projectId: { in: u.projectIds } };
  const payouts = await db.payout.findMany({
    where: { booking: { unit: scope }, ...(status ? { status } : {}) },
    include: { booking: { include: { unit: { include: { project: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  const all = await db.payout.findMany({ where: { booking: { unit: scope } }, select: { status: true, amount: true } });
  const sum = (s: string[]) => all.filter((p) => s.includes(p.status)).reduce((a, p) => a + p.amount, 0);
  const isMaker = u.role === "ACCOUNTS";
  const canPay = ["ACCOUNTS", "FINANCE_HEAD"].includes(u.role);

  return (
    <>
      <PageHeader eyebrow="Sales" title="Payouts" />
      <SubNav active="/sales/payouts" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Pending" value={inr(sum(["PENDING"]))} tone="warn" sub="Not yet sent for approval" />
        <Stat label="In approval or approved" value={inr(sum(["IN_APPROVAL", "APPROVED"]))} sub="Waiting to be paid" />
        <Stat label="Paid" value={inr(sum(["PAID"]))} tone="good" />
      </div>
      <p className="mb-4 text-sm text-stone">Payouts are created automatically when a unit is booked. Accounts sends them for approval, approvers sign off in Approvals, then Accounts marks them paid.</p>

      <Card pad={false}>
        <form method="get" className="flex flex-wrap gap-2 border-b border-line p-4">
          <select className="input max-w-52" name="status" defaultValue={status}>
            <option value="">All statuses</option>
            {["PENDING", "IN_APPROVAL", "APPROVED", "PAID", "REJECTED"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}
          </select>
          <Button variant="secondary">Filter</Button>
        </form>
        <Table head={["Payee", "Type", "Booking", { label: "Rate", num: true }, { label: "Amount", num: true }, "Status", "Created", ""]} empty="No payouts.">
          {payouts.map((p) => (
            <tr key={p.id}>
              <td className="font-medium">{p.payeeName}</td>
              <td className="text-xs">{p.type === "CP_COMMISSION" ? "Partner commission" : "Sales incentive"}</td>
              <td><Link href={`/sales/bookings/${p.bookingId}`} className="hover:underline">{p.booking.unit.number}</Link><div className="text-xs text-stone">{p.booking.unit.project.name}</div></td>
              <td className="num">{p.ratePct}%</td>
              <td className="num">{inr(p.amount, { exact: true })}</td>
              <td><Status value={p.status} /></td>
              <td className="text-xs text-stone">{date(p.createdAt)}</td>
              <td>
                {p.status === "PENDING" && isMaker && (
                  <form action={sendPayoutForApproval}><input type="hidden" name="payoutId" value={p.id} /><Button size="sm" variant="secondary">Send for approval</Button></form>
                )}
                {p.status === "APPROVED" && canPay && (
                  <form action={markPayoutPaid}><input type="hidden" name="payoutId" value={p.id} /><Button size="sm">Mark paid</Button></form>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
