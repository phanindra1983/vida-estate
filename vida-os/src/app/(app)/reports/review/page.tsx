import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { date } from "@/lib/format";
import { scorecard, defaultRate, currentYM, MONTHS, RAG_DOT, fmtKpi, monthEnd, type ScoreRow } from "@/lib/performance";
import { projectExecution, collectionsTrend, inventoryDashboard, salesUpdate, autoSummary, xRag } from "@/lib/review";
import { PageHeader, Card, Stat, Notice } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const ROLES = ["MD", "FINANCE_HEAD", "SALES_HEAD", "GM_PROJECTS"];
const SECTIONS = [
  { key: "WORKED", title: "What worked", tone: "border-[#cfe3d6]" },
  { key: "NOT_WORKED", title: "What did not work, lessons taken", tone: "border-[#efd9b8]" },
  { key: "CONCERNS", title: "Looking-forward concerns", tone: "border-[#ecc9c1]" },
  { key: "ACTIONS", title: "Our actions", tone: "border-line" },
];

async function saveCommentary(fd: FormData) {
  "use server";
  const u = await requireUser(ROLES);
  const year = Number(fd.get("year")), month = Number(fd.get("month"));
  const entries = [...fd.entries()].filter(([k]) => k.startsWith("note:")).map(([k, v]) => [k.slice(5), String(v).trim().slice(0, 4000)] as const);
  await db.$transaction(entries.map(([section, text]) => db.reviewNote.upsert({
    where: { year_month_section: { year, month, section } },
    create: { year, month, section, text, updatedById: u.id },
    update: { text, updatedById: u.id },
  })));
  await audit(u, "UPDATE", "ReviewNote", `${year}-${month}`, `Updated the ${MONTHS[month - 1]} ${year} business review commentary`);
  revalidatePath("/reports/review");
  redirect(`/reports/review?y=${year}&m=${month}&saved=1#summary`);
}

function Num({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10 break-inside-avoid">
      <h2 className="mb-4 flex items-center gap-3 font-serif text-2xl"><span className="flex h-8 w-8 items-center justify-center rounded-full border border-[#a07a45] text-sm text-[#a07a45]">{n}</span>{title}</h2>
      {children}
    </section>
  );
}

function Bars({ actual, target, unit, labels }: { actual: number[]; target: number[]; unit: "inr" | "count"; labels: string[] }) {
  const max = Math.max(1, ...actual, ...target);
  return (
    <div className="flex h-40 items-end gap-1.5">
      {labels.map((l, i) => (
        <div key={l} className="flex flex-1 flex-col items-center gap-1" title={`${l}: ${fmtKpi(unit, actual[i])}${target.length ? ` vs plan ${fmtKpi(unit, target[i])}` : ""}`}>
          <div className="relative flex h-32 w-full items-end justify-center">
            {target.length > 0 && <div className="absolute w-full border-t-2 border-dashed border-[#a07a45]" style={{ bottom: `${(target[i] / max) * 100}%` }} />}
            <div className={`w-3/4 rounded-t ${target.length && actual[i] < target[i] * 0.8 ? "bg-[#c98b7f]" : "bg-ink"}`} style={{ height: `${(actual[i] / max) * 100}%` }} />
          </div>
          <span className="text-[10px] text-stone">{l}</span>
        </div>
      ))}
    </div>
  );
}

export default async function BusinessReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser(ROLES);
  const sp = await searchParams;
  const now = currentYM();
  const year = Number(sp.y) || now.year;
  const month = Math.min(12, Math.max(1, Number(sp.m) || now.month));
  const scope = u.projectIds;
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

  const [score, exec, trend, inv, sales, dr, notes, pending, planRows] = await Promise.all([
    scorecard(year, month, scope),
    projectExecution(scope),
    collectionsTrend(year, scope),
    inventoryDashboard(year, month, scope),
    salesUpdate(year, month, scope),
    defaultRate(monthEnd(year, month), scope),
    db.reviewNote.findMany({ where: { year, month } }),
    db.approvalRequest.count({ where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - 3 * 864e5) } } }),
    db.planTarget.count({ where: { year, projectId: "", value: { gt: 0 } } }),
  ]);
  const note = new Map(notes.map((n) => [n.section, n.text]));
  const auto = autoSummary(score, exec, inv, pending);
  const autoFor: Record<string, string[]> = { WORKED: auto.worked, NOT_WORKED: auto.notWorked, CONCERNS: auto.concerns, ACTIONS: [] };
  const sv = score.find((r) => r.kpi === "SALES_VALUE")!, col = score.find((r) => r.kpi === "COLLECTIONS")!;
  const drRow = score.find((r) => r.kpi === "DEFAULT_RATE")!;
  const totals = exec.reduce((a, p) => ({ devCost: a.devCost + p.devCost, tsv: a.tsv + p.tsv, sold: a.sold + p.sold, collected: a.collected + p.collected, committed: a.committed + p.committed }), { devCost: 0, tsv: 0, sold: 0, collected: 0, committed: 0 });
  const pctCell = (r: ScoreRow["ytd"]) => (r.pct == null ? "–" : `${Math.round(r.pct)}%`);

  return (
    <>
      <PageHeader eyebrow={`Reports · ${MONTHS[month - 1]} ${year}`} title="Business review">
        <div className="no-print flex items-center gap-2">
          <Link href={`/reports/review?y=${prev.y}&m=${prev.m}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-3 text-sm">← {MONTHS[prev.m - 1]}</Link>
          <Link href={`/reports/review?y=${next.y}&m=${next.m}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-3 text-sm">{MONTHS[next.m - 1]} →</Link>
          <PrintButton label="Print / PDF" />
        </div>
      </PageHeader>
      {sp.saved && <div className="mb-6"><Notice tone="good">Commentary saved.</Notice></div>}
      {!planRows && <div className="mb-6"><Notice>No business plan for {year} yet, so there is nothing to measure against. <Link className="underline underline-offset-4" href={`/control/plan?year=${year}`}>Enter the plan</Link>.</Notice></div>}
      <p className="mb-8 max-w-3xl text-sm text-stone">The monthly business review: every number against plan. 🟢 100% or more · 🟡 80–99% · 🔴 below 80%. The summary fills itself from the numbers; add your own lines and actions, then save.</p>

      <form action={saveCommentary}>
        <input type="hidden" name="year" value={year} />
        <input type="hidden" name="month" value={month} />

        <Num n={1} title={`Executive summary: ${MONTHS[month - 1]} ${year}`}>
          <div id="summary" className="grid gap-4 lg:grid-cols-2">
            {SECTIONS.map((s) => (
              <div key={s.key} className={`rounded-xl border-2 bg-white p-4 ${s.tone}`}>
                <h3 className="mb-2 font-medium">{s.title}</h3>
                {autoFor[s.key].length > 0 && <ul className="mb-3 grid list-disc gap-1 pl-5 text-sm">{autoFor[s.key].map((l) => <li key={l}>{l}</li>)}</ul>}
                <textarea name={`note:${s.key}`} defaultValue={note.get(s.key) ?? ""} className="input min-h-20 text-sm" placeholder={s.key === "ACTIONS" ? "What we will do: owner and date for each action" : "Add context in your own words"} />
              </div>
            ))}
          </div>
        </Num>

        <Num n={2} title="Goals status">
          <Card pad={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-stone">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2.5">KPI</th><th className="px-3 py-2.5 text-right">Plan {year}</th><th className="px-3 py-2.5 text-right">Plan YTD</th><th className="px-3 py-2.5 text-right">Actual YTD</th><th className="px-3 py-2.5 text-center">%</th>
                    <th className="px-3 py-2.5 text-right">{MONTHS[month - 1]} plan</th><th className="px-3 py-2.5 text-right">{MONTHS[month - 1]} actual</th><th className="px-3 py-2.5 text-right">Year estimate</th><th className="px-3 py-2.5">Comment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {score.map((r) => (
                    <tr key={r.kpi} className="align-top">
                      <td className="px-3 py-2.5"><p className="font-medium">{r.label}</p><p className="text-xs text-stone">{r.hint}</p></td>
                      <td className="px-3 py-2.5 text-right">{fmtKpi(r.unit, r.fy.target)}</td>
                      <td className="px-3 py-2.5 text-right">{r.kpi === "DEFAULT_RATE" ? "–" : fmtKpi(r.unit, r.ytd.target)}</td>
                      <td className="px-3 py-2.5 text-right font-medium">{fmtKpi(r.unit, r.ytd.actual)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-center">{pctCell(r.ytd)} {RAG_DOT[r.ytd.rag]}</td>
                      <td className="px-3 py-2.5 text-right">{r.kpi === "DEFAULT_RATE" ? "–" : fmtKpi(r.unit, r.month.target)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">{r.kpi === "DEFAULT_RATE" ? "–" : <>{fmtKpi(r.unit, r.month.actual)} {RAG_DOT[r.month.rag]}</>}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">{r.kpi === "DEFAULT_RATE" ? "–" : <>{fmtKpi(r.unit, r.fy.estimate)} {RAG_DOT[r.fy.rag]}</>}</td>
                      <td className="min-w-56 px-3 py-2"><input name={`note:KPI:${r.kpi}`} defaultValue={note.get(`KPI:${r.kpi}`) ?? ""} className="input min-h-9 py-1 text-xs" placeholder="Why, and what next" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="mt-2 text-xs text-stone">Year estimate = actual so far plus the last three months&apos; average for each remaining month.</p>
          <div className="no-print mt-4"><button className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white">Save commentary</button></div>
        </Num>
      </form>

      <Num n={3} title="Sales and collections vs plan">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={`Net sales · YTD ${fmtKpi("inr", sv.ytd.actual)} vs plan ${fmtKpi("inr", sv.ytd.target)}`}>
            <Bars actual={sv.series.actual} target={sv.series.target} unit="inr" labels={MONTHS} />
          </Card>
          <Card title={`Collections · YTD ${fmtKpi("inr", col.ytd.actual)} vs plan ${fmtKpi("inr", col.ytd.target)}`}>
            <Bars actual={trend.slice(1)} target={col.series.target} unit="inr" labels={MONTHS} />
          </Card>
        </div>
        <p className="mt-2 text-xs text-stone">Bars: actual. Dashed line: plan. A muted bar is below 80% of plan.</p>
      </Num>

      <Num n={4} title="Project execution status">
        <Card pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-stone">
                <tr className="border-b border-line">
                  <th className="px-3 py-2.5">Project</th><th className="px-3 py-2.5 text-right">Dev. cost</th><th className="px-3 py-2.5 text-right">Total sales value</th><th className="px-3 py-2.5 text-right">Sold</th><th className="px-3 py-2.5 text-center">Sold ÷ cost</th>
                  <th className="px-3 py-2.5 text-right">Collected</th><th className="px-3 py-2.5 text-center">Collected ÷ cost</th><th className="px-3 py-2.5 text-right">Ordered</th><th className="px-3 py-2.5 text-center">Plan / Actual</th><th className="px-3 py-2.5">RERA / Expected</th><th className="px-3 py-2.5 text-right">Buffer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {exec.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2.5 font-medium">{p.name}</td>
                    <td className="px-3 py-2.5 text-right">{fmtKpi("inr", p.devCost)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtKpi("inr", p.tsv)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtKpi("inr", p.sold)}</td>
                    <td className="px-3 py-2.5 text-center">{p.finClosure == null ? "–" : `${p.finClosure.toFixed(1)}x ${xRag(p.finClosure)}`}</td>
                    <td className="px-3 py-2.5 text-right">{fmtKpi("inr", p.collected)}</td>
                    <td className="px-3 py-2.5 text-center">{p.collClosure == null ? "–" : `${p.collClosure.toFixed(1)}x ${xRag(p.collClosure)}`}</td>
                    <td className="px-3 py-2.5 text-right">{p.procurementPct == null ? "–" : `${p.procurementPct.toFixed(0)}%`}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-center">{p.planned == null ? "–" : <>{p.planned.toFixed(1)}% / {p.actual?.toFixed(1)}% <span className={(p.variance ?? 0) < 0 ? "text-bad" : "text-good"}>({(p.variance ?? 0) > 0 ? "+" : ""}{p.variance?.toFixed(1)})</span></>}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs">{p.rera ? date(p.rera) : <span className="text-stone">RERA date not set</span>}<br />{p.est ? date(p.est) : <span className="text-stone">estimate not set</span>}</td>
                    <td className={`px-3 py-2.5 text-right ${p.bufferDays != null && p.bufferDays < 90 ? "text-bad" : ""}`}>{p.bufferDays == null ? "–" : `${p.bufferDays} d`}</td>
                  </tr>
                ))}
                <tr className="bg-[#f6f4f0] font-medium">
                  <td className="px-3 py-2.5">Total</td><td className="px-3 py-2.5 text-right">{fmtKpi("inr", totals.devCost)}</td><td className="px-3 py-2.5 text-right">{fmtKpi("inr", totals.tsv)}</td><td className="px-3 py-2.5 text-right">{fmtKpi("inr", totals.sold)}</td>
                  <td className="px-3 py-2.5 text-center">{totals.devCost ? `${(totals.sold / totals.devCost).toFixed(1)}x ${xRag(totals.sold / totals.devCost)}` : "–"}</td>
                  <td className="px-3 py-2.5 text-right">{fmtKpi("inr", totals.collected)}</td>
                  <td className="px-3 py-2.5 text-center">{totals.devCost ? `${(totals.collected / totals.devCost).toFixed(1)}x ${xRag(totals.collected / totals.devCost)}` : "–"}</td>
                  <td className="px-3 py-2.5 text-right">{totals.devCost ? `${((totals.committed / totals.devCost) * 100).toFixed(0)}%` : "–"}</td><td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
        <p className="mt-2 text-xs text-stone">Sold ÷ cost and Collected ÷ cost: 🟢 1x or more · 🟡 0.8–1x · 🔴 below 0.8x. Plan / Actual: share of the construction schedule that should be done by today vs is done. Buffer: days between the expected completion and the RERA date. Set both dates on each project in Masters.</p>
      </Num>

      <Num n={5} title="Collections and customer default">
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={`Collected, ${MONTHS[month - 1]}`} value={fmtKpi("inr", col.month.actual)} sub={col.month.target ? `plan ${fmtKpi("inr", col.month.target)} ${RAG_DOT[col.month.rag]}` : "no plan"} />
          <Stat label="Collected, year to date" value={fmtKpi("inr", col.ytd.actual)} sub={col.ytd.target ? `plan ${fmtKpi("inr", col.ytd.target)} ${RAG_DOT[col.ytd.rag]}` : "no plan"} />
          <Stat label="Unpaid over 90 days" value={fmtKpi("inr", dr.over90)} tone={dr.over90 ? "bad" : "good"} sub={`of ${fmtKpi("inr", dr.invoiced)} demanded so far`} />
          <Stat label="Default rate" value={`${dr.pct.toFixed(2)}%`} sub={drRow.ytd.target != null ? `target ${drRow.ytd.target}% ${RAG_DOT[drRow.ytd.rag]}` : "set a target in the plan"} tone={drRow.ytd.rag === "RED" ? "bad" : drRow.ytd.rag === "GREEN" ? "good" : undefined} />
        </div>
        {dr.byProject.length > 0 && (
          <Card title="Over-90-day dues by project" pad={false}>
            <ul className="divide-y divide-line text-sm">{dr.byProject.map(([n, v]) => <li key={n} className="flex justify-between px-5 py-2.5"><span>{n}</span><span className="font-medium">{fmtKpi("inr", v)}</span></li>)}</ul>
          </Card>
        )}
      </Num>

      <Num n={6} title="Available inventory">
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Available to sell" value={`${inv.total.units} units`} sub={fmtKpi("inr", inv.total.value)} />
          <Stat label="On hold for a buyer (48 h)" value={`${inv.onHold.units} units`} sub={fmtKpi("inr", inv.onHold.value)} />
          <Stat label="Not launched yet" value={`${inv.notLaunched.units} units`} sub={fmtKpi("inr", inv.notLaunched.value)} />
          <Stat label={`Sold in ${MONTHS[month - 1]}`} value={`${inv.movement.sold.units} units`} sub={`${inv.movement.cancelled.units} came back from cancellations`} />
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="By project" pad={false}>
            <ul className="divide-y divide-line text-sm">{inv.byProject.map((p) => <li key={p.name} className="flex justify-between px-5 py-2.5"><span>{p.name}<span className="text-xs text-stone"> · {p.units} units</span></span><span className="font-medium">{fmtKpi("inr", p.value)}</span></li>)}</ul>
          </Card>
          <Card title="By ageing (since launch)" pad={false}>
            <ul className="divide-y divide-line text-sm">{inv.ageing.map((a) => <li key={a.label} className="flex justify-between px-5 py-2.5"><span>{a.label}<span className="text-xs text-stone"> · {a.units} units</span></span><span className="font-medium">{fmtKpi("inr", a.value)}</span></li>)}</ul>
          </Card>
          <Card title="By home type" pad={false}>
            <ul className="divide-y divide-line text-sm">{inv.types.map((t) => <li key={t.type} className="flex justify-between px-5 py-2.5"><span>{t.type}<span className="text-xs text-stone"> · {t.units} units</span></span><span className="font-medium">{fmtKpi("inr", t.value)}</span></li>)}</ul>
          </Card>
        </div>
        <Card title={`Inventory movement, ${MONTHS[month - 1]}`} className="mt-6">
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            {[["Opening", inv.movement.opening], ["Sold", inv.movement.sold], ["Cancelled (back in stock)", inv.movement.cancelled], ["Closing", inv.movement.closing]].map(([l, v]) => (
              <div key={l as string}><p className="text-xs text-stone">{l as string}</p><p className="text-lg font-medium">{(v as { units: number }).units} units</p><p className="text-xs">{fmtKpi("inr", (v as { value: number }).value)}</p></div>
            ))}
          </div>
        </Card>
      </Num>

      <Num n={7} title="Sales update and cancellations, year to date">
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Units sold" value={sales.units} sub={`last year same period: ${sales.unitsLY}`} />
          <Stat label="Average ticket size" value={fmtKpi("inr", sales.ticket)} sub={`last year: ${fmtKpi("inr", sales.ticketLY)}`} />
          <Stat label="Gross sales" value={fmtKpi("inr", sales.total)} />
          <Stat label="Cancellations" value={fmtKpi("inr", sales.cancelledValue)} tone={sales.cancelledValue ? "warn" : undefined} sub={`${sales.cancellations.reduce((s, c) => s + c.units, 0)} units`} />
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Sales by project" pad={false}>
            <ul className="divide-y divide-line text-sm">{sales.byProject.length ? sales.byProject.map((p) => <li key={p.name} className="flex justify-between px-5 py-2.5"><span>{p.name}<span className="text-xs text-stone"> · {p.units} units</span></span><span className="font-medium">{fmtKpi("inr", p.value)} <span className="text-xs text-stone">({sales.total ? Math.round((p.value / sales.total) * 100) : 0}%)</span></span></li>) : <li className="px-5 py-3 text-stone">No sales yet this year.</li>}</ul>
          </Card>
          <Card title="Cancellations by project" pad={false}>
            <ul className="divide-y divide-line text-sm">{sales.cancellations.length ? sales.cancellations.map((p) => <li key={p.name} className="flex justify-between px-5 py-2.5"><span>{p.name}<span className="text-xs text-stone"> · {p.units} units</span></span><span className="font-medium">{fmtKpi("inr", p.value)}</span></li>) : <li className="px-5 py-3 text-stone">No cancellations this year.</li>}</ul>
          </Card>
        </div>
      </Num>

      <Num n={8} title="Cost control: budget vs ordered vs paid">
        <Card pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-stone"><tr className="border-b border-line"><th className="px-3 py-2.5">Project</th><th className="px-3 py-2.5 text-right">Budget</th><th className="px-3 py-2.5 text-right">Ordered (committed)</th><th className="px-3 py-2.5 text-right">Paid / billed</th><th className="px-3 py-2.5 text-right">Left to order</th></tr></thead>
              <tbody className="divide-y divide-line">
                {exec.map((p) => (
                  <tr key={p.id}><td className="px-3 py-2.5 font-medium">{p.name}</td><td className="px-3 py-2.5 text-right">{fmtKpi("inr", p.devCost)}</td><td className="px-3 py-2.5 text-right">{fmtKpi("inr", p.committed)}</td><td className="px-3 py-2.5 text-right">{fmtKpi("inr", p.spent)}</td><td className={`px-3 py-2.5 text-right ${p.devCost - p.committed < 0 ? "text-bad" : ""}`}>{fmtKpi("inr", p.devCost - p.committed)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </Num>
    </>
  );
}
