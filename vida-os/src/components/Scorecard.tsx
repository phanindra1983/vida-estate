import Link from "next/link";
import { getUser } from "@/lib/auth";
import { scorecard, currentYM, MONTHS, RAG_DOT, fmtKpi, type Kpi } from "@/lib/performance";

/**
 * Plan-vs-actual strip for the top of a section (Leads, Bookings, Collections…):
 * this month and year to date against the business plan, with 🟢🟡🔴.
 */
export async function Scorecard({ kpis }: { kpis: Kpi[] }) {
  const u = await getUser();
  if (!u) return null;
  const { year, month } = currentYM();
  const rows = (await scorecard(year, month, u.projectIds)).filter((r) => kpis.includes(r.kpi));
  const noPlan = rows.every((r) => r.ytd.target == null);
  return (
    <div className="mb-6 rounded-xl border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-stone">
        <span>Against plan · {MONTHS[month - 1]} {year}</span>
        <Link href={noPlan ? "/control/plan" : `/reports/review?y=${year}&m=${month}`} className="underline underline-offset-4">{noPlan ? "Set the plan" : "Business review"}</Link>
      </div>
      <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.kpi} className="px-4 py-3">
            <p className="text-xs uppercase tracking-wider text-stone">{r.label}</p>
            {r.kpi === "DEFAULT_RATE" ? (
              <p className="mt-1 text-lg font-medium">{fmtKpi(r.unit, r.ytd.actual)} {RAG_DOT[r.ytd.rag]} <span className="text-xs font-normal text-stone">{r.ytd.target != null ? `target ${r.ytd.target}%` : "no target"}</span></p>
            ) : (
              <>
                <p className="mt-1 text-lg font-medium">{fmtKpi(r.unit, r.month.actual)} {RAG_DOT[r.month.rag]} <span className="text-xs font-normal text-stone">{r.month.target != null ? `of ${fmtKpi(r.unit, r.month.target)} this month` : "this month"}</span></p>
                <p className="text-xs text-stone">Year to date {fmtKpi(r.unit, r.ytd.actual)}{r.ytd.target != null ? ` of ${fmtKpi(r.unit, r.ytd.target)} (${Math.round(r.ytd.pct ?? 0)}%) ${RAG_DOT[r.ytd.rag]}` : ""}</p>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
