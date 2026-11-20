import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { SALES_ROLES, SALES_MANAGERS, BLOCK_HOURS } from "@/lib/constants";
import { inr, datetime, num } from "@/lib/format";
import { effectiveStatus, leadScope } from "@/lib/sales";
import { PageHeader, Card, Status, Button, Field, LinkButton, Notice } from "@/components/ui";
import { blockUnit, extendBlock, releaseBlock, bookUnit } from "../../actions";
import { Flash, one, type SP } from "../../_ui";

export const dynamic = "force-dynamic";

export default async function UnitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const u = await requireUser([...SALES_ROLES, "FINANCE_HEAD"]);
  const { id } = await params;
  const sp = await searchParams;
  const unit = await db.unit.findUnique({
    where: { id },
    include: { project: { include: { plans: { include: { stages: { orderBy: { seq: "asc" } } } } } }, tower: true, bookings: { where: { status: { not: "CANCELLED" } } } },
  });
  if (!unit || !canSeeProject(u, unit.projectId)) notFound();

  const st = effectiveStatus(unit);
  const canSell = SALES_ROLES.includes(u.role) && u.role !== "MARKETING";
  const isManager = SALES_MANAGERS.includes(u.role);
  const [blockLead, blocker, leads] = await Promise.all([
    unit.blockedLeadId ? db.lead.findUnique({ where: { id: unit.blockedLeadId }, include: { channelPartner: true } }) : null,
    unit.blockedById ? db.user.findUnique({ where: { id: unit.blockedById } }) : null,
    st === "AVAILABLE" && canSell
      ? db.lead.findMany({
          where: { AND: [leadScope(u), { projectId: unit.projectId, stage: { in: ["CONTACTED", "VISIT_SCHEDULED", "VISIT_DONE", "NEGOTIATION"] } }] },
          orderBy: { lastActivityAt: "desc" },
          take: 100,
        })
      : [],
  ]);
  const canBook = st === "BLOCKED" && canSell && (unit.blockedById === u.id || isManager);
  const path = `/sales/inventory/${unit.id}`;
  const booking = unit.bookings[0];

  return (
    <>
      <PageHeader eyebrow={`${unit.project.name} · ${unit.tower.name}`} title={`Unit ${unit.number}`}>
        <LinkButton href={`/sales/inventory?project=${unit.projectId}&tower=${unit.towerId}`} variant="ghost" size="sm">Back to inventory</LinkButton>
      </PageHeader>
      <Flash ok={one(sp.ok)} error={one(sp.error)} />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Unit details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
            <dt className="text-stone">Status</dt><dd><Status value={st} /></dd>
            <dt className="text-stone">Type</dt><dd>{unit.type}</dd>
            <dt className="text-stone">Floor</dt><dd>{unit.floor}</dd>
            <dt className="text-stone">Facing</dt><dd>{unit.facing}</dd>
            <dt className="text-stone">Carpet area</dt><dd>{num(unit.carpetSqft)} sq ft</dd>
            <dt className="text-stone">Super built-up</dt><dd>{num(unit.sbaSqft)} sq ft</dd>
            <dt className="text-stone">List price</dt><dd className="font-medium">{inr(unit.price, { exact: true })} ({inr(unit.price)})</dd>
            <dt className="text-stone">Rate</dt><dd>₹{num(Math.round(unit.price / unit.sbaSqft))} per sq ft</dd>
            {st === "BLOCKED" && (
              <>
                <dt className="text-stone">Blocked for</dt><dd>{blockLead ? <Link className="underline underline-offset-4" href={`/sales/leads/${blockLead.id}`}>{blockLead.name}</Link> : "–"}</dd>
                <dt className="text-stone">Blocked by</dt><dd>{blocker?.name ?? "–"}</dd>
                <dt className="text-stone">Until</dt><dd>{datetime(unit.blockedUntil)}</dd>
              </>
            )}
          </dl>
          {st === "BLOCKED" && (isManager || unit.blockedById === u.id) && (
            <div className="mt-5 flex flex-wrap gap-2">
              {isManager && (
                <form action={extendBlock}><input type="hidden" name="unitId" value={unit.id} /><input type="hidden" name="back" value={path} /><Button variant="secondary" size="sm">Extend 24 hours</Button></form>
              )}
              <form action={releaseBlock}><input type="hidden" name="unitId" value={unit.id} /><input type="hidden" name="back" value={path} /><Button variant="danger" size="sm">Release unit</Button></form>
            </div>
          )}
        </Card>

        {st === "BOOKED" && (
          <Card title="Booking">
            {booking ? (
              <div className="grid gap-3 text-sm">
                <p>Booked by <strong>{booking.buyerName}</strong> for {inr(booking.agreementValue)}.</p>
                <LinkButton href={`/sales/bookings/${booking.id}`} variant="secondary">Open booking</LinkButton>
              </div>
            ) : <p className="text-sm text-stone">Booked.</p>}
          </Card>
        )}

        {st === "AVAILABLE" && canSell && (
          <Card title={`Block for a buyer (${BLOCK_HOURS} hours)`}>
            {leads.length === 0 ? (
              <p className="text-sm text-stone">You have no active leads for {unit.project.name}. Open a lead and block from there.</p>
            ) : (
              <form action={blockUnit} className="grid gap-4">
                <input type="hidden" name="unitId" value={unit.id} />
                <input type="hidden" name="back" value={path} />
                <Field label="Buyer (lead)">
                  <select className="input" name="leadId" required>
                    {leads.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.phone}{l.preferredType ? ` · wants ${l.preferredType}` : ""}</option>)}
                  </select>
                </Field>
                <p className="text-xs text-stone">While blocked, nobody else can block or book this unit. The block ends by itself after {BLOCK_HOURS} hours.</p>
                <div><Button>Block unit</Button></div>
              </form>
            )}
          </Card>
        )}

        {st === "BLOCKED" && !canBook && (
          <Card title="Booking"><p className="text-sm text-stone">Only {blocker?.name ?? "the person who blocked it"} or a sales manager can book this unit.</p></Card>
        )}

        {canBook && blockLead && (
          <Card title="Book this unit">
            <form action={bookUnit} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="unitId" value={unit.id} />
              <input type="hidden" name="back" value={path} />
              <Field label="Buyer name (as on agreement)"><input className="input" name="buyerName" defaultValue={blockLead.name} required /></Field>
              <Field label="Mobile"><input className="input" name="buyerPhone" defaultValue={blockLead.phone} required inputMode="tel" /></Field>
              <Field label="Email"><input className="input" name="buyerEmail" type="email" defaultValue={blockLead.email ?? ""} /></Field>
              <Field label="Payment plan">
                <select className="input" name="planId" required>
                  {unit.project.plans.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} · {p.type === "DOWN_PAYMENT" ? `${inr(Math.round(unit.price * 0.97))} standard` : inr(unit.price)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Agreement value (₹)" hint="List price for the construction-linked plan, 3% less for down payment. A lower figure goes for discount approval.">
                <input className="input" name="agreementValue" inputMode="numeric" defaultValue={unit.price} required />
              </Field>
              <Field label="Token amount (₹)"><input className="input" name="tokenAmount" inputMode="numeric" defaultValue={500000} required /></Field>
              <Field label="Token payment reference" hint="UTR, UPI or cheque number"><input className="input" name="paymentRef" required /></Field>
              <div className="sm:col-span-2">
                {blockLead.channelPartner && (
                  <div className="mb-3"><Notice tone="neutral">This buyer came through {blockLead.channelPartner.name}. A {blockLead.channelPartner.commissionPct}% partner commission will be created on booking.</Notice></div>
                )}
                <Button>Record booking</Button>
              </div>
            </form>
            <div className="mt-6 border-t border-line pt-4 text-xs text-stone">
              <p className="mb-2 font-medium text-ink-2">Payment plans</p>
              {unit.project.plans.map((p) => (
                <p key={p.id} className="mb-1">{p.name}: {p.stages.map((s) => `${s.name} ${s.pct}%`).join(" · ")}</p>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
