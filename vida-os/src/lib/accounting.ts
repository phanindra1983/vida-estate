import { db } from "./db";

/**
 * Accounting entries for the export. Each row is ready for Tally, Zoho Books or a
 * future in-house ledger: a voucher type, ledger names, project cost centre and tax fields.
 */
export type Entry = {
  date: string; voucherType: string; voucherNo: string; party: string; ledgerDebit: string; ledgerCredit: string;
  costCentre: string; costHead: string; taxable: number; gst: number; tds: number; total: number; narration: string;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function accountingEntries(from: Date, to: Date): Promise<Entry[]> {
  const [bills, receipts, payouts] = await Promise.all([
    db.vendorBill.findMany({ where: { status: { in: ["PAYABLE", "IN_PAYMENT", "PAID"] }, billDate: { gte: from, lt: to } }, include: { vendor: true, po: { include: { project: true, costCode: true } } } }),
    db.receipt.findMany({ where: { receivedAt: { gte: from, lt: to } }, include: { booking: { include: { unit: { include: { project: true } } } }, demand: { include: { stage: true } } } }),
    db.payout.findMany({ where: { status: { in: ["APPROVED", "PAID"] }, createdAt: { gte: from, lt: to } }, include: { booking: { include: { unit: { include: { project: true } } } } } }),
  ]);
  const out: Entry[] = [];
  for (const b of bills) {
    const taxable = Math.round(b.qty * b.rate);
    const gst = b.amount - taxable;
    const tds = Math.round((taxable * b.tdsPct) / 100);
    out.push({
      date: iso(b.billDate), voucherType: "Purchase", voucherNo: b.billNo, party: b.vendor.name,
      ledgerDebit: `${b.po.costCode.name} (WIP)`, ledgerCredit: b.vendor.name,
      costCentre: b.po.project.code, costHead: b.po.costCode.code, taxable, gst, tds, total: b.amount,
      narration: `${b.po.number} · ${b.po.item} · GSTIN ${b.vendor.gstin ?? "–"}`,
    });
  }
  for (const r of receipts) {
    out.push({
      date: iso(r.receivedAt), voucherType: "Receipt", voucherNo: r.number, party: r.booking.buyerName,
      ledgerDebit: `RERA collection account · ${r.booking.unit.project.code}`, ledgerCredit: "Customer advances",
      costCentre: r.booking.unit.project.code, costHead: "", taxable: r.amount, gst: 0, tds: 0, total: r.amount,
      narration: `Unit ${r.booking.unit.number} · ${r.demand?.stage.name ?? "advance"} · ${r.mode} ${r.reference}`,
    });
  }
  for (const p of payouts) {
    out.push({
      date: iso(p.createdAt), voucherType: "Journal", voucherNo: p.id.slice(-8).toUpperCase(), party: p.payeeName,
      ledgerDebit: p.type === "CP_COMMISSION" ? "Brokerage and commission" : "Sales incentives",
      ledgerCredit: p.payeeName, costCentre: p.booking.unit.project.code, costHead: "12", taxable: p.amount, gst: 0,
      tds: p.type === "CP_COMMISSION" ? Math.round(p.amount * 0.05) : 0, total: p.amount,
      narration: `${p.type === "CP_COMMISSION" ? "Channel-partner commission" : "Sales incentive"} at ${p.ratePct}% on unit ${p.booking.unit.number}`,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function toCsv(rows: Entry[]) {
  const head = ["Date", "Voucher type", "Voucher no", "Party", "Debit ledger", "Credit ledger", "Cost centre", "Cost head", "Taxable", "GST", "TDS", "Total", "Narration"];
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [head, ...rows.map((r) => [r.date, r.voucherType, r.voucherNo, r.party, r.ledgerDebit, r.ledgerCredit, r.costCentre, r.costHead, r.taxable, r.gst, r.tds, r.total, r.narration])]
    .map((row) => row.map(esc).join(",")).join("\n");
}
