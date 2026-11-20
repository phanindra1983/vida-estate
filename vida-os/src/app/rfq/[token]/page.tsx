import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { evaluateRfq } from "@/lib/procurement";
import { audit } from "@/lib/audit";
import { date, datetime, num } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Public vendor quote page, reached from the link in an enquiry. No login: the token is the key. */
async function submitQuote(fd: FormData) {
  "use server";
  const token = String(fd.get("token"));
  const inv = await db.rfqInvite.findUnique({ where: { token }, include: { rfq: true } });
  if (!inv) redirect("/rfq/invalid");
  const back = `/rfq/${token}`;
  if (inv.rfq.status !== "SENT" || Date.now() > inv.rfq.quoteDueAt.getTime()) redirect(`${back}?e=closed`);
  if (fd.get("decline") === "1") {
    await db.rfqInvite.update({ where: { id: inv.id }, data: { status: "DECLINED" } });
    await evaluateRfq(inv.rfqId);
    redirect(`${back}?done=declined`);
  }
  const n = (k: string) => Number(String(fd.get(k) ?? "").replace(/,/g, ""));
  const rate = n("rate"), gstPct = n("gstPct"), deliveryDays = Math.round(n("deliveryDays")), freight = Math.round(n("freight") || 0);
  if (!(rate > 0) || !(gstPct >= 0) || !(deliveryDays >= 0)) redirect(`${back}?e=fields`);
  const data = { rate, gstPct, deliveryDays, freight, paymentTerms: String(fd.get("paymentTerms") || "") || null, validityDays: Math.round(n("validityDays")) || 15, remarks: String(fd.get("remarks") || "").slice(0, 500) || null };
  await db.rfqQuote.upsert({ where: { rfqId_vendorId: { rfqId: inv.rfqId, vendorId: inv.vendorId } }, create: { rfqId: inv.rfqId, vendorId: inv.vendorId, ...data }, update: { ...data, submittedAt: new Date() } });
  await db.rfqInvite.update({ where: { id: inv.id }, data: { status: "QUOTED" } });
  const v = await db.vendor.findUnique({ where: { id: inv.vendorId } });
  await audit({ id: `vendor:${inv.vendorId}`, name: v?.name ?? "Vendor" }, "CREATE", "RfqQuote", inv.rfqId, `${v?.name} quoted ₹${rate}/${inv.rfq.unit} on ${inv.rfq.number}`);
  await evaluateRfq(inv.rfqId);
  redirect(`${back}?done=quoted`);
}

export default async function VendorQuote({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; e?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const inv = await db.rfqInvite.findUnique({ where: { token }, include: { rfq: { include: { material: true } } } });
  if (!inv) return <Shell><h1 className="font-serif text-3xl">This link is not valid.</h1><p className="mt-2 text-stone">Please check the link in the enquiry, or contact the Vida Estates purchase team.</p></Shell>;
  if (!inv.openedAt) await db.rfqInvite.update({ where: { id: inv.id }, data: { openedAt: new Date(), status: inv.status === "SENT" ? "OPENED" : inv.status } });
  const r = inv.rfq;
  const [vendor, project, existing] = await Promise.all([
    db.vendor.findUnique({ where: { id: inv.vendorId } }),
    db.project.findUniqueOrThrow({ where: { id: r.projectId } }),
    db.rfqQuote.findUnique({ where: { rfqId_vendorId: { rfqId: r.id, vendorId: inv.vendorId } } }),
  ]);
  const open = r.status === "SENT" && Date.now() <= r.quoteDueAt.getTime();

  return (
    <Shell>
      <p className="eyebrow">Request for quotation · {r.number}</p>
      <h1 className="mt-2 font-serif text-4xl">{r.material.name}</h1>
      <p className="mt-2 text-stone">For {vendor?.name}</p>

      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-line bg-white p-5 text-sm sm:grid-cols-3">
        <Item k="Quantity" v={`${num(r.qty)} ${r.unit}`} />
        <Item k="Deliver to" v={`${project.name}, ${project.location}`} />
        <Item k="Needed on site by" v={date(r.needOnSite)} />
        <Item k="Quote by" v={datetime(r.quoteDueAt)} />
        {r.material.specs && <Item k="Specification" v={r.material.specs} />}
      </dl>

      {sp.done === "quoted" && <Msg tone="good">Thank you. Your quote is received. You can update it below until quotes close.</Msg>}
      {sp.done === "declined" && <Msg tone="neutral">Noted. Thank you for letting us know.</Msg>}
      {sp.e === "closed" && <Msg tone="bad">Quotes for this enquiry have closed.</Msg>}
      {sp.e === "fields" && <Msg tone="bad">Please enter the rate, GST % and delivery days.</Msg>}

      {open ? (
        <form action={submitQuote} className="mt-8 grid gap-4 rounded-xl border border-line bg-white p-5 sm:grid-cols-2">
          <input type="hidden" name="token" value={token} />
          <L label={`Rate per ${r.unit}, before GST (₹)`}><input name="rate" inputMode="decimal" required defaultValue={existing?.rate ?? ""} className="input" /></L>
          <L label="GST %"><input name="gstPct" inputMode="decimal" required defaultValue={existing?.gstPct ?? 18} className="input" /></L>
          <L label="Freight to site, total (₹)"><input name="freight" inputMode="numeric" defaultValue={existing?.freight ?? 0} className="input" /></L>
          <L label="Delivery after order (days)"><input name="deliveryDays" inputMode="numeric" required defaultValue={existing?.deliveryDays ?? r.material.leadTimeDays} className="input" /></L>
          <L label="Payment terms"><input name="paymentTerms" defaultValue={existing?.paymentTerms ?? "30 days credit"} className="input" /></L>
          <L label="Quote valid for (days)"><input name="validityDays" inputMode="numeric" defaultValue={existing?.validityDays ?? 15} className="input" /></L>
          <div className="sm:col-span-2"><L label="Remarks (brand, make, conditions)"><input name="remarks" defaultValue={existing?.remarks ?? ""} className="input" /></L></div>
          <div className="flex flex-wrap gap-3 sm:col-span-2">
            <button className="min-h-11 rounded-lg bg-ink px-5 text-sm font-medium text-white">{existing ? "Update my quote" : "Submit my quote"}</button>
            {!existing && <button name="decline" value="1" className="min-h-11 rounded-lg border border-line px-5 text-sm">We cannot quote this time</button>}
          </div>
        </form>
      ) : (
        !sp.e && !sp.done && <Msg tone="neutral">Quotes for this enquiry have closed.</Msg>
      )}
      <p className="mt-10 text-xs text-stone">Vida Estates, Hyderabad · Purchase team. Your quote is shared only with Vida Estates staff.</p>
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
function Item({ k, v }: { k: string; v: string }) {
  return <div><dt className="eyebrow">{k}</dt><dd className="mt-1">{v}</dd></div>;
}
function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field">{label}{children}</label>;
}
function Msg({ tone, children }: { tone: "good" | "bad" | "neutral"; children: React.ReactNode }) {
  const c = tone === "good" ? "border-[#c9dfd2] bg-[#eef6f1] text-good" : tone === "bad" ? "border-[#e5c4bd] bg-[#fbefec] text-bad" : "border-line bg-white text-ink-2";
  return <div className={`mt-6 rounded-lg border px-4 py-3 text-sm ${c}`}>{children}</div>;
}
