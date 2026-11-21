import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { COLLECTION_ROLES } from "@/lib/constants";
import { inr, date, datetime, pct } from "@/lib/format";
import { isOverdue } from "@/lib/collections";
import { PageHeader, Card, Table, Status, Badge, Button, Field, LinkButton, Stat } from "@/components/ui";
import { recordReceipt, setBookingStatus, setPortalLink } from "../../actions";
import { waLink, publicUrl } from "@/lib/notify";
import { Flash, one, type SP } from "../../_ui";

export const dynamic = "force-dynamic";

export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const u = await requireUser([...COLLECTION_ROLES, "SALES_EXEC"]);
  const canManage = COLLECTION_ROLES.includes(u.role);
  const { id } = await params;
  const sp = await searchParams;
  const b = await db.booking.findUnique({
    where: { id },
    include: {
      unit: { include: { project: true, tower: true } },
      plan: { include: { stages: { orderBy: { seq: "asc" } } } },
      lead: { include: { channelPartner: true } },
      demands: { include: { stage: true, receipts: true }, orderBy: { raisedAt: "asc" } },
      receipts: { orderBy: { receivedAt: "desc" } },
      payouts: true,
    },
  });
  if (!b || !canSeeProject(u, b.unit.projectId) || (!canManage && b.lead.ownerId !== u.id)) notFound();

  const [bookedBy, discount] = await Promise.all([
    db.user.findUnique({ where: { id: b.bookedById } }),
    db.approvalRequest.findFirst({ where: { action: "DISCOUNT", entityId: b.id } }),
  ]);
  const demanded = b.demands.reduce((s, d) => s + d.amount, 0);
  const received = b.receipts.reduce((s, r) => s + r.amount, 0);
  const overdueAmt = b.demands.filter((d) => isOverdue(d)).reduce((s, d) => s + d.amount - d.receipts.reduce((a, r) => a + r.amount, 0), 0);
  const raisedStages = new Set(b.demands.map((d) => d.planStageId));
  const path = `/sales/bookings/${b.id}`;
  const openDemands = b.demands.filter((d) => d.status !== "PAID");

  return (
    <>
      <PageHeader eyebrow={`${b.unit.project.name} · ${b.unit.tower.name}`} title={`${b.unit.number} · ${b.buyerName}`}>
        <LinkButton href="/sales/bookings" variant="ghost" size="sm">All bookings</LinkButton>
      </PageHeader>
      <Flash ok={one(sp.ok)} error={one(sp.error)} />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Agreement value" value={inr(b.agreementValue)} sub={b.plan.name} />
        <Stat label="Demanded so far" value={inr(demanded)} sub={`${pct(demanded, b.agreementValue)}% of value`} />
        <Stat label="Received" value={inr(received)} tone="good" sub={`${pct(received, demanded)}% of demanded`} />
        <Stat label="Overdue" value={inr(overdueAmt)} tone={overdueAmt > 0 ? "bad" : "good"} sub={overdueAmt > 0 ? "Follow up with the buyer" : "Nothing overdue"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="grid content-start gap-6">
          <Card title="Demand letters" pad={false}>
            <Table head={["Number", "Stage", { label: "Amount", num: true }, "Due", "Status", ""]}>
              {b.demands.map((d) => {
                const paid = d.receipts.reduce((s, r) => s + r.amount, 0);
                return (
                  <tr key={d.id}>
                    <td className="font-medium">{d.number}</td>
                    <td>{d.stage.name}<div className="text-xs text-stone">{d.stage.pct}%</div></td>
                    <td className="num">{inr(d.amount)}{paid > 0 && paid < d.amount && <div className="text-xs text-stone">paid {inr(paid)}</div>}</td>
                    <td className="text-xs">{date(d.dueDate)}</td>
                    <td>{isOverdue(d) ? <Badge tone="bad">Overdue</Badge> : <Status value={d.status} />}</td>
                    <td><Link href={`/sales/bookings/${b.id}/demand/${d.id}`} className="text-xs underline underline-offset-4">Letter</Link></td>
                  </tr>
                );
              })}
            </Table>
            <div className="border-t border-line px-5 py-3 text-xs text-stone">
              Still to come: {b.plan.stages.filter((s) => !raisedStages.has(s.id)).map((s) => `${s.name} (${s.pct}%)`).join(" · ") || "nothing, the plan is fully demanded"}
            </div>
          </Card>

          <Card title="Receipts" pad={false}>
            <Table head={["Number", { label: "Amount", num: true }, "Mode", "Reference", "Received"]} empty="No money received yet.">
              {b.receipts.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.number}</td>
                  <td className="num">{inr(r.amount, { exact: true })}</td>
                  <td>{r.mode}</td>
                  <td className="text-xs">{r.reference}</td>
                  <td className="text-xs text-stone">{date(r.receivedAt)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          {canManage && <Card title="Record a receipt">
            <form action={recordReceipt} className="grid gap-3">
              <input type="hidden" name="bookingId" value={b.id} />
              <input type="hidden" name="back" value={path} />
              <Field label="Against demand">
                <select className="input" name="demandId" defaultValue={openDemands[0]?.id ?? ""}>
                  {openDemands.map((d) => <option key={d.id} value={d.id}>{d.number} · {d.stage.name} · {inr(d.amount - d.receipts.reduce((s, r) => s + r.amount, 0))} open</option>)}
                  <option value="">Advance (no demand)</option>
                </select>
              </Field>
              <Field label="Amount (₹)"><input className="input" name="amount" inputMode="numeric" required /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Mode">
                  <select className="input" name="mode">{["NEFT", "RTGS", "UPI", "CHEQUE"].map((m) => <option key={m}>{m}</option>)}</select>
                </Field>
                <Field label="Bank reference"><input className="input" name="reference" required /></Field>
              </div>
              <div><Button>Save receipt</Button></div>
            </form>
          </Card>}

          <Card title="Booking">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-stone">Status</dt><dd><Status value={b.status} /></dd>
              <dt className="text-stone">Buyer</dt><dd>{b.buyerName}<div className="text-xs text-stone">{b.buyerPhone}{b.buyerEmail ? ` · ${b.buyerEmail}` : ""}</div></dd>
              <dt className="text-stone">Unit</dt><dd><Link className="underline underline-offset-4" href={`/sales/inventory/${b.unitId}`}>{b.unit.number}</Link> · {b.unit.type} · list {inr(b.unit.price)}</dd>
              <dt className="text-stone">Token</dt><dd>{inr(b.tokenAmount, { exact: true })} · {b.paymentRef}</dd>
              <dt className="text-stone">Booked</dt><dd>{datetime(b.bookedAt)} by {bookedBy?.name ?? "–"}</dd>
              <dt className="text-stone">Lead</dt><dd><Link className="underline underline-offset-4" href={`/sales/leads/${b.leadId}`}>Open lead</Link>{b.lead.channelPartner ? ` · via ${b.lead.channelPartner.name}` : ""}</dd>
              {discount && (<><dt className="text-stone">Discount</dt><dd>{inr(discount.amount)} <Status value={discount.status} /></dd></>)}
            </dl>
            {canManage && <div className="mt-5 flex flex-wrap gap-2">
              {b.status === "BOOKED" && (
                <form action={setBookingStatus}><input type="hidden" name="bookingId" value={b.id} /><input type="hidden" name="back" value={path} /><input type="hidden" name="status" value="AGREEMENT_SIGNED" /><Button variant="secondary" size="sm">Mark agreement signed</Button></form>
              )}
              {b.status === "AGREEMENT_SIGNED" && (
                <form action={setBookingStatus}><input type="hidden" name="bookingId" value={b.id} /><input type="hidden" name="back" value={path} /><input type="hidden" name="status" value="REGISTERED" /><Button variant="secondary" size="sm">Mark registered</Button></form>
              )}
            </div>}
          </Card>

          {canManage && (
            <Card title="Customer portal">
              {b.portalToken ? (() => {
                const link = publicUrl(`/my/${b.portalToken}`);
                const msg = `Dear ${b.buyerName.split(" ")[0]}, here is your private Vida Estates page for ${b.unit.number}, ${b.unit.project.name}. See your payment schedule, receipts and construction progress with photos: ${link}`;
                return (
                  <div className="grid gap-3 text-sm">
                    <p className="text-stone">The buyer sees their payments, receipts and construction progress with site photos. No password needed; the link is the key.</p>
                    <input className="input text-xs" readOnly value={link} aria-label="Portal link" />
                    <div className="flex flex-wrap gap-2">
                      <a href={waLink(b.buyerPhone, msg)} target="_blank" rel="noreferrer" className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white">Send on WhatsApp</a>
                      <a href={link} target="_blank" rel="noreferrer" className="rounded-lg border border-line px-3 py-1.5 text-sm">Open as buyer</a>
                    </div>
                    <p className="text-xs text-stone">{b.portalOpenedAt ? `Buyer last opened it ${datetime(b.portalOpenedAt)}` : "Not opened yet"}</p>
                    <div className="flex flex-wrap gap-2">
                      <form action={setPortalLink}><input type="hidden" name="bookingId" value={b.id} /><input type="hidden" name="back" value={path} /><Button size="sm" variant="secondary">New link</Button></form>
                      <form action={setPortalLink}><input type="hidden" name="bookingId" value={b.id} /><input type="hidden" name="back" value={path} /><input type="hidden" name="mode" value="off" /><Button size="sm" variant="danger">Turn off</Button></form>
                    </div>
                  </div>
                );
              })() : (
                <form action={setPortalLink} className="grid gap-3 text-sm">
                  <input type="hidden" name="bookingId" value={b.id} />
                  <input type="hidden" name="back" value={path} />
                  <p className="text-stone">Give the buyer a private page with their payment schedule, receipts and construction progress with site photos.</p>
                  <div><Button size="sm">Create portal link</Button></div>
                </form>
              )}
            </Card>
          )}

          {b.payouts.length > 0 && (
            <Card title="Payouts on this booking">
              <ul className="grid gap-2 text-sm">
                {b.payouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3">
                    <span>{p.payeeName}<span className="block text-xs text-stone">{p.type === "CP_COMMISSION" ? "Partner commission" : "Sales incentive"} · {p.ratePct}%</span></span>
                    <span className="text-right">{inr(p.amount)}<span className="block"><Status value={p.status} /></span></span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
