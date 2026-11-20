import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { COLLECTION_ROLES } from "@/lib/constants";
import { inr, date } from "@/lib/format";
import { LinkButton } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

export default async function DemandLetter({ params }: { params: Promise<{ id: string; demandId: string }> }) {
  const u = await requireUser([...COLLECTION_ROLES, "SALES_EXEC"]);
  const { id, demandId } = await params;
  const d = await db.demand.findUnique({
    where: { id: demandId },
    include: { stage: true, receipts: true, booking: { include: { unit: { include: { project: true, tower: true } }, plan: true, lead: { select: { ownerId: true } } } } },
  });
  if (!d || d.bookingId !== id || !canSeeProject(u, d.booking.unit.projectId) || (u.role === "SALES_EXEC" && d.booking.lead.ownerId !== u.id)) notFound();
  const b = d.booking;
  const paid = d.receipts.reduce((s, r) => s + r.amount, 0);
  const balance = Math.max(0, d.amount - paid);

  return (
    <>
      <div className="no-print mb-6 flex flex-wrap gap-2">
        <PrintButton label="Print or save as PDF" />
        <LinkButton href={`/sales/bookings/${b.id}`} variant="ghost">Back to booking</LinkButton>
      </div>

      <article className="mx-auto max-w-3xl rounded-xl border border-line bg-white p-10 text-sm leading-relaxed print:border-0 print:p-0">
        <header className="flex items-start justify-between border-b border-line pb-6">
          <img src="/logo-dark.svg" alt="Vida Estates" className="w-36" />
          <div className="text-right text-xs text-stone">
            <p>Vida Estates</p>
            <p>Hyderabad, Telangana</p>
            <p>TS RERA: {b.unit.project.reraNo ?? "–"}</p>
          </div>
        </header>

        <div className="mt-6 flex justify-between text-xs text-stone">
          <span>Demand letter {d.number}</span>
          <span>Date: {date(d.raisedAt)}</span>
        </div>

        <p className="mt-6">To,<br /><strong>{b.buyerName}</strong><br />Mobile: {b.buyerPhone}{b.buyerEmail ? <><br />Email: {b.buyerEmail}</> : null}</p>

        <p className="mt-6"><strong>Subject: Payment due for Unit {b.unit.number}, {b.unit.tower.name}, {b.unit.project.name}</strong></p>

        <p className="mt-4">Dear {b.buyerName.split(" ")[0]},</p>
        <p className="mt-3">
          Thank you for choosing {b.unit.project.name}. As per your {b.plan.name.toLowerCase()}, the instalment linked to <strong>{d.stage.name.toLowerCase()}</strong> is now due. Please find the details below.
        </p>

        <table className="mt-6 w-full border-collapse text-sm">
          <tbody>
            {[
              ["Unit", `${b.unit.number} · ${b.unit.type} · ${b.unit.tower.name}`],
              ["Agreement value", inr(b.agreementValue, { exact: true })],
              ["Instalment", `${d.stage.name} (${d.stage.pct}%)`],
              ["Amount due", inr(d.amount, { exact: true })],
              ...(paid > 0 ? [["Received against this demand", inr(paid, { exact: true })], ["Balance payable", inr(balance, { exact: true })]] : []),
              ["Due date", date(d.dueDate)],
            ].map(([k, v]) => (
              <tr key={k} className="border-b border-line">
                <td className="py-2.5 pr-6 text-stone">{k}</td>
                <td className="py-2.5 font-medium">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 rounded-lg bg-[#f6f3ee] p-4 text-xs">
          <p className="font-medium">Pay by NEFT / RTGS to the project collection account</p>
          <p className="mt-1 text-stone">Account name: Vida Estates, {b.unit.project.name} Collection Account · Bank: to be confirmed · Account no.: to be confirmed · IFSC: to be confirmed</p>
          <p className="mt-1 text-stone">Please mention your unit number {b.unit.number} in the payment remarks.</p>
        </div>

        <p className="mt-6">Payments made after the due date may attract interest as per your agreement. If you have already paid, please share the reference with us and ignore this letter.</p>
        <p className="mt-8">Warm regards,<br /><strong>Customer Relations, Vida Estates</strong></p>

        <footer className="mt-10 border-t border-line pt-4 text-[11px] text-stone">
          This is a system-generated letter from Vida OS.
        </footer>
      </article>
    </>
  );
}
