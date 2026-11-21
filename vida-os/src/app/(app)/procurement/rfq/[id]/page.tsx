import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { comparison, runEngineIfStale } from "@/lib/procurement";
import { publicUrl, waLink } from "@/lib/notify";
import { date, datetime, inr, num } from "@/lib/format";
import { PageHeader, Card, Table, Badge, Status, Button, Notice, LinkButton } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { chooseVendor, sendReminders, closeQuotes, cancelRfq, simulateQuotes, checkMailNow } from "../../actions";
import { checkInboxIfStale, inboxConfigured, lastInboxCheck, type Attachment } from "@/lib/mail-inbox";

export const dynamic = "force-dynamic";

export default async function RfqPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(PROCUREMENT_ROLES);
  const { id } = await params;
  const sp = await searchParams;
  await Promise.all([runEngineIfStale(), checkInboxIfStale()]);
  const r = await db.rfq.findUnique({ where: { id }, include: { invites: true, material: true } });
  if (!r || !canSeeProject(u, r.projectId)) notFound();
  const [project, milestone, cmp, approval] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: r.projectId } }),
    r.milestoneId ? db.milestone.findUnique({ where: { id: r.milestoneId } }) : null,
    comparison(r.id),
    db.approvalRequest.findFirst({ where: { entityType: "Rfq", entityId: r.id }, orderBy: { createdAt: "desc" }, include: { steps: true } }),
  ]);
  const vendors = new Map((await db.vendor.findMany({ where: { id: { in: r.invites.map((i) => i.vendorId) } } })).map((v) => [v.id, v]));
  const [inbound, outbound, inbox] = await Promise.all([
    db.rfqMessage.findMany({ where: { rfqId: r.id } }),
    db.outboxMessage.findMany({ where: { channel: "EMAIL", OR: [{ refType: "RfqInvite", refId: { in: r.invites.map((i) => i.id) } }, { refType: "Rfq", refId: r.id }] } }),
    lastInboxCheck(),
  ]);
  const inviteVendor = new Map(r.invites.map((i) => [i.id, i.vendorId]));
  const trail = [
    ...outbound.map((m) => ({ key: m.id, dir: "OUT" as const, at: m.createdAt, who: vendors.get(inviteVendor.get(m.refId ?? "") ?? "")?.name ?? m.to, subject: m.subject ?? "", body: m.body, files: [] as Attachment[], note: m.status === "SENT" ? (m.error ?? "Sent") : `${m.status === "QUEUED" ? "Not sent" : "Failed"}: ${m.error ?? ""}` })),
    ...inbound.map((m) => ({ key: m.id, dir: "IN" as const, at: m.receivedAt, who: (m.vendorId && vendors.get(m.vendorId)?.name) || m.fromAddr, subject: m.subject, body: m.body, files: JSON.parse(m.attachments) as Attachment[], note: m.matchedBy === "SENDER" ? "Filed here by sender (no enquiry number in the subject)" : "" })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const po = r.poId ? await db.purchaseOrder.findUnique({ where: { id: r.poId } }) : null;
  const canAct = ["MD", "GM_PROJECTS", "PROJECT_MANAGER", "PURCHASE"].includes(u.role);
  const rows = cmp.rows;
  const best = cmp.recommended;
  const chosen = rows.find((x) => x.quoteId === (r.awardedQuoteId ?? r.recommendedQuoteId));

  return (
    <>
      <div className="no-print">
        <PageHeader eyebrow={`Procurement engine · ${project.name}`} title={`${r.number} · ${r.material.name}`}>
          <LinkButton href="/procurement/enquiries" variant="ghost" size="sm">All enquiries</LinkButton>
          <PrintButton label="Print comparison" />
        </PageHeader>
        {sp.ok && <div className="mb-4"><Notice tone="good">{sp.ok}</Notice></div>}
        {sp.error && <div className="mb-4"><Notice tone="bad">{sp.error}</Notice></div>}
        {r.note && <div className="mb-4"><Notice tone="warn">{r.note}</Notice></div>}
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <Fact label="Status" value={<><Status value={r.status} /> {r.live ? <Badge tone="bad">Live: real suppliers</Badge> : <Badge>Test mode</Badge>}</>} />
        <Fact label="Quantity" value={`${num(r.qty)} ${r.unit}`} />
        <Fact label="Needed on site" value={date(r.needOnSite)} sub={milestone ? `for ${milestone.name}` : undefined} />
        <Fact label="Order by" value={date(r.orderBy)} sub={`Quotes close ${datetime(r.quoteDueAt)}`} />
      </div>

      {/* Comparison statement */}
      <Card title="Comparison statement" className="mb-6 print:border-0" pad={false}>
        <div className="hidden px-5 pt-5 print:block">
          <img src="/logo-dark.svg" alt="Vida Estates" className="w-28" />
          <p className="mt-3 text-sm">{project.name} · {r.number} · {r.material.name} · {num(r.qty)} {r.unit} · prepared {date(new Date())}</p>
        </div>
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-stone">No quotes yet. {r.invites.length} vendor(s) invited; quotes close {datetime(r.quoteDueAt)}.</p>
        ) : (
          <>
            <Table head={["Rank", "Vendor", { label: "Rate", num: true }, { label: "Basic", num: true }, { label: "Freight", num: true }, { label: "GST", num: true }, { label: "Landed cost", num: true }, "Delivery", "Terms", { label: "Score", num: true }]}>
              {rows.map((q) => (
                <tr key={q.quoteId} className={q.recommended ? "bg-[#fbf6ec]" : ""}>
                  <td>L{q.rank}</td>
                  <td>
                    <span className="font-medium">{q.vendor}</span> {q.recommended && <Badge tone="brass">Recommended</Badge>}
                    <p className="text-xs text-stone">{"★".repeat(q.rating)}{q.remarks ? ` · ${q.remarks}` : ""}</p>
                  </td>
                  <td className="num">{inr(q.rate, { exact: true })}/{r.unit}{q.vsRef != null && <p className={`text-xs ${q.vsRef > 0 ? "text-bad" : "text-good"}`}>{q.vsRef > 0 ? "+" : ""}{q.vsRef}% vs last</p>}</td>
                  <td className="num">{inr(q.basic)}</td>
                  <td className="num">{q.freight ? inr(q.freight) : "–"}</td>
                  <td className="num">{inr(q.gst)}<p className="text-xs text-stone">{q.gstPct}%</p></td>
                  <td className="num font-medium">{inr(q.landed)}</td>
                  <td className="whitespace-nowrap">{q.deliveryDays} d{q.lateBy ? <p className="text-xs text-bad">{q.lateBy} d late</p> : <p className="text-xs text-good">On time</p>}</td>
                  <td className="text-xs">{q.paymentTerms}<br />Valid {q.validityDays} d</td>
                  <td className="num">{q.score}</td>
                </tr>
              ))}
            </Table>
            <div className="border-t border-line px-5 py-4 text-sm">
              {best && <p><span className="font-medium">Recommendation:</span> {best.vendor}, landed {inr(best.landed)}, {best.lateBy ? `${best.lateBy} days after the need date` : "arriving before the need date"}.
                {rows[0] && best.quoteId !== rows[0].quoteId && <> It is not the cheapest ({rows[0].vendor} is {inr(best.landed - rows[0].landed)} lower) because of delivery time or vendor rating.</>}
                {rows[0] && best.quoteId === rows[0].quoteId && rows[1] && <> Saves {inr(rows[1].landed - best.landed)} against the next quote.</>}</p>}
              <p className="mt-1 text-xs text-stone">Landed cost = quantity × rate + freight + GST. Score out of 100: price 70, delivery against the need date 20, vendor rating 10.</p>
            </div>
          </>
        )}
      </Card>

      <div className="no-print grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Decision">
          {r.status === "AWARDED" && (
            <p className="text-sm">Awarded to <span className="font-medium">{chosen?.vendor}</span>.{" "}
              {po && <>Purchase order <Link href={`/cost/orders/${po.id}`} className="underline">{po.number}</Link> is <Status value={po.status} />.</>}</p>
          )}
          {r.status === "IN_APPROVAL" && approval && (
            <p className="text-sm">With the approvers: award to <span className="font-medium">{chosen?.vendor}</span> for {inr(approval.amount)} (level {approval.currentLevel} of {approval.requiredLevel}). <Link href="/approvals" className="underline">Open approvals</Link></p>
          )}
          {r.status === "SENT" && <p className="text-sm text-stone">Waiting for quotes. The comparison is built and sent for approval automatically once every vendor has answered or quotes close with at least 2 quotes.</p>}
          {r.status === "CANCELLED" && <p className="text-sm text-stone">Cancelled.</p>}
          {r.status === "READY" && canAct && rows.length > 0 && (
            <form action={chooseVendor} className="grid gap-3">
              <input type="hidden" name="rfqId" value={r.id} />
              <p className="text-sm">Choose the vendor to send for approval.</p>
              {rows.map((q) => (
                <label key={q.quoteId} className="flex items-center gap-3 rounded-lg border border-line p-3 text-sm">
                  <input type="radio" name="quoteId" value={q.quoteId} defaultChecked={q.recommended} className="h-5 w-5 accent-[#121413]" />
                  <span className="flex-1">{q.vendor} {q.recommended && <Badge tone="brass">Recommended</Badge>}</span>
                  <span className="font-medium">{inr(q.landed)}</span>
                </label>
              ))}
              <input name="reason" className="input" placeholder="Reason, if not the recommended vendor" />
              <div><Button>Send for approval</Button></div>
            </form>
          )}
          {r.status === "SENT" && canAct && (
            <div className="mt-4 flex flex-wrap gap-2">
              <form action={sendReminders}><input type="hidden" name="rfqId" value={r.id} /><Button size="sm" variant="secondary">Remind vendors</Button></form>
              {rows.length > 0 && <form action={closeQuotes}><input type="hidden" name="rfqId" value={r.id} /><Button size="sm" variant="secondary">Close quotes now</Button></form>}
              {process.env.DEMO_MODE !== "false" && <form action={simulateQuotes}><input type="hidden" name="rfqId" value={r.id} /><Button size="sm" variant="ghost">Demo: fill vendor quotes</Button></form>}
            </div>
          )}
          {["SENT", "READY"].includes(r.status) && canAct && (
            <form action={cancelRfq} className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
              <input type="hidden" name="rfqId" value={r.id} />
              <input name="reason" className="input max-w-xs" placeholder="Reason to cancel" />
              <Button size="sm" variant="danger">Cancel enquiry</Button>
            </form>
          )}
        </Card>

        <Card title={`Vendors invited (${r.invites.length})`} pad={false}>
          <ul className="divide-y divide-line text-sm">
            {r.invites.map((inv) => {
              const v = vendors.get(inv.vendorId);
              const link = publicUrl(`/rfq/${inv.token}`);
              return (
                <li key={inv.id} className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{v?.name}</span>
                    <Status value={inv.status === "QUOTED" ? "RECEIVED" : inv.status === "SENT" ? "PENDING" : inv.status} />
                  </div>
                  <p className="text-xs text-stone">{v?.email ?? "no email"} · {v?.phone ?? "no phone"}{inv.remindedAt ? ` · reminded ${date(inv.remindedAt)}` : ""}</p>
                  {canAct && inv.status !== "QUOTED" && (
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      {v?.phone && <a className="underline" target="_blank" rel="noreferrer" href={waLink(v.phone, `Vida Estates enquiry ${r.number}: ${r.material.name}, ${num(r.qty)} ${r.unit}. Please quote by ${date(r.quoteDueAt)}: ${link}`)}>Send on WhatsApp</a>}
                      <a className="underline" href={link} target="_blank" rel="noreferrer">Open vendor quote page</a>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title={`Email trail (${trail.length})`} className="no-print mt-6" pad={false}
        action={<form action={checkMailNow}><input type="hidden" name="rfqId" value={r.id} /><Button size="sm" variant="secondary">Check mail now</Button></form>}>
        <p className="border-b border-line px-5 py-3 text-xs text-stone">
          {inboxConfigured()
            ? <>Supplier replies are read from the purchase mailbox and filed here.{inbox ? ` Last checked ${datetime(new Date(inbox.checkedAt))}.` : ""}{inbox?.error ? ` Last check failed: ${inbox.error}` : ""}</>
            : <>Supplier replies will appear here once the purchase mailbox is connected (the Gmail app password, SMTP_PASS).</>}
        </p>
        {trail.length === 0 ? <p className="p-5 text-sm text-stone">No emails on this enquiry yet.</p> : (
          <ul className="divide-y divide-line">
            {trail.map((m) => {
              const fresh = m.dir === "IN" && Date.now() - m.at.getTime() < 864e5;
              return (
                <li key={m.key} className={`p-5 text-sm ${m.dir === "IN" ? "bg-[#fbf6ec]" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={m.dir === "IN" ? "brass" : undefined}>{m.dir === "IN" ? "📩 Reply from supplier" : "Sent by Vida"}</Badge>
                    {fresh && <Badge tone="good">New</Badge>}
                    <span className="font-medium">{m.who}</span>
                    <span className="ml-auto text-xs text-stone">{datetime(m.at)}</span>
                  </div>
                  <p className="mt-1 text-xs text-stone">{m.subject}{m.dir === "OUT" && m.note ? ` · ${m.note}` : ""}{m.dir === "IN" && m.note ? ` · ${m.note}` : ""}</p>
                  <details className="mt-2" open={m.dir === "IN"}>
                    <summary className="cursor-pointer text-xs text-stone">{m.dir === "IN" ? "Message" : "Show the email"}</summary>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">{m.body}</pre>
                  </details>
                  {m.files.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      {m.files.map((f) => <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="underline">📎 {f.name} ({Math.max(1, Math.round(f.size / 1024))} KB)</a>)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

function Fact({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <p className="eyebrow">{label}</p>
      <div className="mt-2 text-lg">{value}</div>
      {sub && <p className="mt-1 text-xs text-stone">{sub}</p>}
    </div>
  );
}
