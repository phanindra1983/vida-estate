import { requireUser } from "@/lib/auth";
import { accountingEntries } from "@/lib/accounting";
import { FINANCE_ROLES } from "@/lib/constants";
import { inr } from "@/lib/format";
import { PageHeader, Card, Table, Badge, Notice, Stat } from "@/components/ui";

export default async function AccountingExport({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requireUser(FINANCE_ROLES);
  const sp = await searchParams;
  const today = new Date();
  const from = sp.from ?? new Date(today.getFullYear(), today.getMonth() - 2, 1).toISOString().slice(0, 10);
  const to = sp.to ?? today.toISOString().slice(0, 10);
  const rows = await accountingEntries(new Date(from), new Date(new Date(to).getTime() + 864e5));
  const sum = (t: string) => rows.filter((r) => r.voucherType === t).reduce((s, r) => s + r.total, 0);

  return (
    <>
      <PageHeader eyebrow="Reports" title="Accounting export">
        <a href={`/api/export/accounting?from=${from}&to=${to}`} className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-ink-2">Download CSV</a>
      </PageHeader>
      <div className="mb-6">
        <Notice tone="neutral">
          Approved vendor bills, buyer receipts and approved payouts, ready to import into your accounting system with project cost centres, GST and TDS. The accounting system (Tally, Zoho Books or in-house) will be chosen in the Finance phase; this file works for any of them.
        </Notice>
      </div>
      <form className="mb-6 flex flex-wrap items-end gap-3">
        <label className="field">From<input type="date" name="from" defaultValue={from} className="input" /></label>
        <label className="field">To<input type="date" name="to" defaultValue={to} className="input" /></label>
        <button className="min-h-11 rounded-lg border border-line bg-white px-4 text-sm">Show</button>
      </form>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Purchase bills" value={inr(sum("Purchase"))} />
        <Stat label="Receipts from buyers" value={inr(sum("Receipt"))} />
        <Stat label="Payout journals" value={inr(sum("Journal"))} />
      </div>
      <Card pad={false}>
        <Table head={["Date", "Type", "No.", "Party", "Debit / Credit", "Cost centre", { label: "GST", num: true }, { label: "TDS", num: true }, { label: "Total", num: true }]} empty="No entries in this period.">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap">{r.date}</td>
              <td><Badge tone={r.voucherType === "Receipt" ? "good" : r.voucherType === "Purchase" ? "neutral" : "brass"}>{r.voucherType}</Badge></td>
              <td className="text-stone">{r.voucherNo}</td>
              <td>{r.party}</td>
              <td className="text-xs">Dr {r.ledgerDebit}<br />Cr {r.ledgerCredit}</td>
              <td>{r.costCentre}{r.costHead && ` · ${r.costHead}`}</td>
              <td className="num">{r.gst ? inr(r.gst, { exact: true }) : "–"}</td>
              <td className="num">{r.tds ? inr(r.tds, { exact: true }) : "–"}</td>
              <td className="num">{inr(r.total, { exact: true })}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
