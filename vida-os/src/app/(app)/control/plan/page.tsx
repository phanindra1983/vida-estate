import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { KPIS, MONTHS, currentYM, yearTargets, type Kpi } from "@/lib/performance";
import { PageHeader, Card, Button, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
const VIEW = ["MD", "FINANCE_HEAD", "SALES_HEAD", "GM_PROJECTS"];
const EDIT = ["MD", "FINANCE_HEAD"];
const MONTHLY = KPIS.filter((k) => k.monthly);
const CR = 1e7;

async function savePlan(fd: FormData) {
  "use server";
  const u = await requireUser(EDIT);
  const year = Number(fd.get("year"));
  const projectId = String(fd.get("projectId") ?? "");
  const back = `/control/plan?year=${year}${projectId ? `&project=${projectId}` : ""}`;
  if (!(year >= 2020 && year <= 2100)) redirect(back);
  const num = (k: string) => {
    const v = String(fd.get(k) ?? "").replace(/[^\d.]/g, "");
    return v === "" ? null : Number(v);
  };
  const rows: { kpi: Kpi; month: number; value: number }[] = [];
  for (const k of MONTHLY) {
    const scale = k.unit === "inr" ? CR : 1;
    const annual = num(`annual_${k.key}`);
    for (let m = 1; m <= 12; m++) {
      const v = annual != null ? (annual / 12) : num(`v_${k.key}_${m}`);
      rows.push({ kpi: k.key, month: m, value: (v ?? 0) * scale });
    }
  }
  const dr = num("v_DEFAULT_RATE_0");
  rows.push({ kpi: "DEFAULT_RATE", month: 0, value: dr ?? 0 });
  await db.$transaction(rows.map((r) => db.planTarget.upsert({
    where: { year_month_projectId_kpi: { year, month: r.month, projectId, kpi: r.kpi } },
    create: { year, month: r.month, projectId, kpi: r.kpi, value: Math.round(r.value * 100) / 100, updatedById: u.id },
    update: { value: Math.round(r.value * 100) / 100, updatedById: u.id },
  })));
  await audit(u, "UPDATE", "PlanTarget", `${year}:${projectId || "company"}`, `Updated the ${year} business plan${projectId ? " for a project" : " (company)"}`);
  revalidatePath("/control/plan");
  redirect(`${back}&ok=1`);
}

export default async function BusinessPlanPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser(VIEW);
  const sp = await searchParams;
  const now = currentYM();
  const year = Number(sp.year) || now.year;
  const projectId = sp.project ?? "";
  const canEdit = EDIT.includes(u.role);
  const [projects, { t, has }] = await Promise.all([
    db.project.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    yearTargets(year, projectId),
  ]);
  const show = (k: (typeof KPIS)[number], v: number) => (v ? (k.unit === "inr" ? +(v / CR).toFixed(2) : +v.toFixed(0)) : "");
  const anyPlan = Object.values(has).some(Boolean);

  return (
    <>
      <PageHeader eyebrow="Control" title="Business plan" />
      {sp.ok && <div className="mb-6"><Notice tone="good">Plan saved. Every dashboard now measures against it.</Notice></div>}
      <p className="mb-6 max-w-3xl text-sm text-stone">
        The budget every dashboard measures against, month by month, the way a monthly business review works: 🟢 100% or more of plan, 🟡 80–99%, 🔴 below 80%. Enter money in <b>₹ crore</b>. To spread a yearly figure evenly, type it in “Whole year” and leave the months empty.
      </p>

      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        {[year - 1, year, year + 1].map((y) => (
          <Link key={y} href={`/control/plan?year=${y}${projectId ? `&project=${projectId}` : ""}`} className={`rounded-full border px-3 py-1.5 ${y === year ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>{y}</Link>
        ))}
        <span className="mx-2 h-6 w-px bg-line" />
        <Link href={`/control/plan?year=${year}`} className={`rounded-full border px-3 py-1.5 ${!projectId ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>Whole company</Link>
        {projects.map((p) => (
          <Link key={p.id} href={`/control/plan?year=${year}&project=${p.id}`} className={`rounded-full border px-3 py-1.5 ${projectId === p.id ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>{p.name}</Link>
        ))}
      </div>
      {!anyPlan && <div className="mb-6"><Notice>No plan entered for {year}{projectId ? " for this project" : ""} yet. Dashboards show actuals only until it is.</Notice></div>}

      <Card pad={false}>
        <form action={savePlan}>
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-stone">
                <tr className="border-b border-line">
                  <th className="px-3 py-2.5">KPI</th>
                  {MONTHS.map((m) => <th key={m} className="px-1 py-2.5 text-center">{m}</th>)}
                  <th className="px-2 py-2.5 text-center">Total</th>
                  <th className="px-2 py-2.5 text-center">Whole year</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {MONTHLY.map((k) => {
                  const total = t[k.key].slice(1).reduce((s, x) => s + x, 0);
                  return (
                    <tr key={k.key}>
                      <td className="px-3 py-2"><p className="font-medium">{k.label}</p><p className="text-xs text-stone">{k.unit === "inr" ? "₹ crore" : "number"} · {k.hint}</p></td>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                        <td key={m} className="px-1 py-2">
                          <input className="input min-h-9 w-16 px-1.5 py-1 text-right text-xs" name={`v_${k.key}_${m}`} defaultValue={show(k, t[k.key][m])} inputMode="decimal" disabled={!canEdit} aria-label={`${k.label} ${MONTHS[m - 1]}`} />
                        </td>
                      ))}
                      <td className="px-2 py-2 text-center text-xs font-medium">{show(k, total) || "–"}</td>
                      <td className="px-2 py-2"><input className="input min-h-9 w-20 px-1.5 py-1 text-right text-xs" name={`annual_${k.key}`} placeholder="spread" inputMode="decimal" disabled={!canEdit} aria-label={`${k.label} whole year`} /></td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="px-3 py-2"><p className="font-medium">Default rate target</p><p className="text-xs text-stone">% · unpaid 90+ days ÷ all demands (Emaar runs at 1%)</p></td>
                  <td className="px-1 py-2" colSpan={14}>
                    <input className="input min-h-9 w-24 px-1.5 py-1 text-right text-xs" name="v_DEFAULT_RATE_0" defaultValue={t.DEFAULT_RATE[0] || ""} placeholder="1.0" inputMode="decimal" disabled={!canEdit} aria-label="Default rate target %" /> %
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {canEdit && <div className="border-t border-line p-4"><Button>Save {year} plan</Button></div>}
        </form>
      </Card>
      <p className="mt-3 text-xs text-stone">Company plan is used on the Business review and section scorecards. A project plan, if entered, is used when that project is selected.</p>
    </>
  );
}
