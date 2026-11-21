import type { Metadata } from "next";
import { db } from "@/lib/db";
import { isOverdue } from "@/lib/collections";
import { inr, date, pct } from "@/lib/format";
import type { SavedPhoto } from "@/lib/cost";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My Vida home", robots: { index: false, follow: false } };

/**
 * The buyer's portal. No login: the private link (Booking.portalToken) is the key,
 * made and turned off by the CRM team from the booking page.
 */
export default async function BuyerPortal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const b = token.length >= 20 ? await db.booking.findUnique({
    where: { portalToken: token },
    include: {
      unit: { include: { project: true, tower: true } },
      plan: { include: { stages: { orderBy: { seq: "asc" } } } },
      demands: { include: { receipts: true }, orderBy: { raisedAt: "asc" } },
      receipts: { orderBy: { receivedAt: "desc" } },
    },
  }) : null;
  if (!b || b.status === "CANCELLED") {
    return (
      <Shell>
        <h1 className="font-serif text-3xl">This link is not active.</h1>
        <p className="mt-2 text-stone">Please ask your Vida Estates relationship manager for a new link.</p>
      </Shell>
    );
  }
  await db.booking.update({ where: { id: b.id }, data: { portalOpenedAt: new Date() } });

  const p = b.unit.project;
  const paid = b.receipts.reduce((a, r) => a + r.amount, 0);
  const demanded = b.demands.reduce((a, d) => a + d.amount, 0);
  const dueNow = b.demands.filter((d) => d.status !== "PAID").map((d) => ({ d, open: d.amount - d.receipts.reduce((a, r) => a + r.amount, 0) })).filter((x) => x.open > 0);
  const owed = dueNow.reduce((a, x) => a + x.open, 0);
  const overdue = dueNow.filter((x) => isOverdue(x.d));

  const [milestones, reports, rm] = await Promise.all([
    db.milestone.findMany({ where: { projectId: p.id, OR: [{ towerId: b.unit.towerId }, { towerId: null }] }, orderBy: { seq: "asc" } }),
    db.dailyReport.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "desc" }, take: 12, select: { photos: true } }),
    db.user.findUnique({ where: { id: b.bookedById }, select: { name: true, phone: true } }),
  ]);
  const progress = milestones.length ? Math.round(milestones.reduce((a, m) => a + (m.status === "DONE" ? 100 : m.progressPct), 0) / milestones.length) : 0;
  const doneCount = milestones.filter((m) => m.status === "DONE").length;
  const now = milestones.find((m) => m.status === "IN_PROGRESS" || m.status === "AWAITING_APPROVAL");
  const photos = reports.flatMap((r) => JSON.parse(r.photos || "[]") as SavedPhoto[]).slice(0, 9);
  const byKey = new Map(milestones.map((m) => [m.key, m]));

  return (
    <Shell>
      <p className="eyebrow">{p.name} · {p.location}</p>
      <h1 className="mt-2 font-serif text-4xl">Hello, {b.buyerName.split(" ")[0]}.</h1>
      <p className="mt-2 text-stone">Your home: <b className="text-ink">{b.unit.number}</b>, {b.unit.tower.name} · {b.unit.type} · {b.unit.carpetSqft.toLocaleString("en-IN")} sq ft carpet · {b.unit.facing} facing</p>

      {/* Money */}
      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile k="Home value" v={inr(b.agreementValue)} />
        <Tile k="You have paid" v={inr(paid)} sub={`${pct(paid, b.agreementValue)}% of value`} tone="good" />
        <Tile k="Due now" v={inr(owed)} tone={overdue.length ? "bad" : undefined} sub={overdue.length ? "past the due date" : owed ? "please pay by the due date" : "nothing due"} />
        <Tile k="Balance to pay" v={inr(Math.max(0, b.agreementValue - paid))} sub="over the construction" />
      </section>

      {dueNow.length > 0 && (
        <div className={`mt-4 rounded-xl border px-5 py-4 text-sm ${overdue.length ? "border-[#e5c4bd] bg-[#fbefec]" : "border-line bg-white"}`}>
          {dueNow.map(({ d, open }) => {
            const stage = b.plan.stages.find((s) => s.id === d.planStageId);
            return <p key={d.id}><b>{inr(open, { exact: true })}</b> for {stage?.name ?? "this stage"} ({d.number}), due {date(d.dueDate)}{isOverdue(d) && <span className="text-bad"> · overdue</span>}</p>;
          })}
          <p className="mt-2 text-stone">Pay by NEFT, RTGS or UPI to the project account in your demand letter, and send the reference to your relationship manager.</p>
        </div>
      )}

      {/* Construction */}
      <section className="mt-10">
        <h2 className="font-serif text-2xl">Construction progress</h2>
        <div className="mt-3 rounded-xl border border-line bg-white p-5">
          <div className="flex items-baseline justify-between"><p className="font-serif text-3xl">{progress}%</p><p className="text-sm text-stone">{doneCount} of {milestones.length} stages done</p></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#ece7de]"><div className="h-full rounded-full bg-good" style={{ width: `${progress}%` }} /></div>
          {now && <p className="mt-3 text-sm">Now working on: <b>{now.name}</b> ({now.progressPct}%)</p>}
          <ol className="mt-4 grid gap-1.5 text-sm">
            {milestones.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3">
                <span className={m.status === "DONE" ? "text-stone line-through decoration-stone/40" : ""}>{m.name}</span>
                <span className="shrink-0 text-xs text-stone">{m.status === "DONE" ? `done ${date(m.actualEnd)}` : m.status === "NOT_STARTED" ? (m.plannedStart.getTime() > Date.now() ? `from ${date(m.plannedStart)}` : "coming up") : `${m.progressPct}%`}</span>
              </li>
            ))}
          </ol>
        </div>
        {photos.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-medium">Latest site photos</h3>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {photos.map((ph) => (
                <a key={ph.path} href={ph.path} target="_blank" rel="noreferrer">
                  <img src={ph.path} alt={`Site photo, ${date(ph.takenAt)}`} className="aspect-square w-full rounded-lg border border-line object-cover" />
                  <span className="mt-0.5 block text-[11px] text-stone">{date(ph.takenAt)}</span>
                </a>
              ))}
            </div>
          </>
        )}
      </section>

      {/* Payment plan */}
      <section className="mt-10">
        <h2 className="font-serif text-2xl">Your payment schedule</h2>
        <p className="mt-1 text-sm text-stone">{b.plan.name}. Each instalment is asked for when its construction stage is complete.</p>
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-white text-sm">
          {b.plan.stages.map((s) => {
            const d = b.demands.find((x) => x.planStageId === s.id);
            const m = s.milestoneKey ? byKey.get(s.milestoneKey) : null;
            const amount = d?.amount ?? Math.round((b.agreementValue * s.pct) / 100);
            const state = !d ? (s.milestoneKey ? `when ${m?.name ?? "that stage"} is complete` : "on booking")
              : d.status === "PAID" ? "paid ✓" : isOverdue(d) ? `overdue since ${date(d.dueDate)}` : `due ${date(d.dueDate)}`;
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-0">
                <div><p>{s.name}</p><p className="text-xs text-stone">{s.pct}% · {state}</p></div>
                <p className={d?.status === "PAID" ? "text-good" : d && isOverdue(d) ? "text-bad" : ""}>{inr(amount)}</p>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-stone">Asked for so far: {inr(demanded)}. Amounts may include GST and other charges as per your agreement.</p>
      </section>

      {/* Receipts */}
      <section className="mt-10">
        <h2 className="font-serif text-2xl">Payments received</h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-white text-sm">
          {b.receipts.length === 0 && <p className="px-4 py-3 text-stone">No payments recorded yet.</p>}
          {b.receipts.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-0">
              <div><p>{r.number}</p><p className="text-xs text-stone">{date(r.receivedAt)} · {r.mode} · {r.reference}</p></div>
              <p>{inr(r.amount, { exact: true })}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10 rounded-xl border border-line bg-white p-5 text-sm">
        <p className="font-medium">Questions?</p>
        <p className="mt-1 text-stone">Your relationship manager{rm ? `, ${rm.name},` : ""} is happy to help{rm?.phone ? <>: <a className="text-ink underline" href={`tel:${rm.phone}`}>{rm.phone}</a></> : "."}</p>
        {p.reraNo && <p className="mt-3 text-xs text-stone">RERA registration {p.reraNo}</p>}
      </section>
      <p className="mt-8 text-xs text-stone">This page is private to you. Please do not share the link.</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <img src="/logo-dark.svg" alt="Vida Estates" className="mb-10 w-28" />
      {children}
    </main>
  );
}

function Tile({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <p className="eyebrow">{k}</p>
      <p className={`mt-1 font-serif text-2xl ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : ""}`}>{v}</p>
      {sub && <p className="mt-0.5 text-xs text-stone">{sub}</p>}
    </div>
  );
}
