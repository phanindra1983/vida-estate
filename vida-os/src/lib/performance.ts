import { db } from "./db";

/**
 * Plan vs actual, the way a monthly Business Review Meeting (BRM) reads it:
 * every KPI against the business plan for the month, year to date and the full year,
 * with a status: 🟢 ≥ 100% · 🟡 80–99% · 🔴 < 80% (for "lower is better" KPIs, target ÷ actual).
 * Months are Indian calendar months (IST). Money in rupees.
 */

export type Kpi = "SALES_VALUE" | "UNITS" | "COLLECTIONS" | "SITE_VISITS" | "QUALIFIED" | "LEADS" | "DEFAULT_RATE";
export const KPIS: { key: Kpi; label: string; unit: "inr" | "count" | "pct"; better: "higher" | "lower"; monthly: boolean; hint: string }[] = [
  { key: "SALES_VALUE", label: "Net sales", unit: "inr", better: "higher", monthly: true, hint: "Agreement value booked, less cancellations" },
  { key: "UNITS", label: "Units sold (net)", unit: "count", better: "higher", monthly: true, hint: "Bookings less cancellations" },
  { key: "COLLECTIONS", label: "Collections", unit: "inr", better: "higher", monthly: true, hint: "Money received from buyers" },
  { key: "SITE_VISITS", label: "Site visits", unit: "count", better: "higher", monthly: true, hint: "Visits booked for the month" },
  { key: "QUALIFIED", label: "Qualified leads", unit: "count", better: "higher", monthly: true, hint: "Leads qualified in the month" },
  { key: "LEADS", label: "New leads", unit: "count", better: "higher", monthly: true, hint: "Enquiries received" },
  { key: "DEFAULT_RATE", label: "Default rate (90+ days)", unit: "pct", better: "lower", monthly: false, hint: "Unpaid over 90 days ÷ everything demanded so far" },
];
export const kpiOf = (k: string) => KPIS.find((x) => x.key === k)!;

export type Rag = "GREEN" | "AMBER" | "RED" | "NONE";
export const RAG_DOT: Record<Rag, string> = { GREEN: "🟢", AMBER: "🟡", RED: "🔴", NONE: "⚪" };
export function ragFor(pct: number | null): Rag {
  if (pct == null || !isFinite(pct)) return "NONE";
  return pct >= 100 ? "GREEN" : pct >= 80 ? "AMBER" : "RED";
}
/** Achievement %: actual ÷ target, or target ÷ actual when lower is better. */
export function achievement(kpi: Kpi, actual: number, target: number | null): number | null {
  if (target == null || target === 0) return null;
  if (kpiOf(kpi).better === "lower") return actual <= 0 ? 999 : (target / actual) * 100;
  return (actual / target) * 100;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const monthStart = (y: number, m: number) => new Date(`${y}-${pad(m)}-01T00:00:00+05:30`);
export const monthEnd = (y: number, m: number) => (m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1));
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function currentYM() {
  const [y, m] = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-").map(Number);
  return { year: y, month: m };
}
const monthOf = (d: Date) => {
  const [y, m] = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-").map(Number);
  return { y, m };
};

/** All the monthly actuals for one year, bucketed in one pass. Index 1..12. */
export async function yearActuals(year: number, projectIds: string[] | "ALL", projectId = "") {
  const from = monthStart(year, 1), to = monthStart(year + 1, 1);
  const pScope = projectId ? { projectId } : projectIds === "ALL" ? {} : { projectId: { in: projectIds } };
  const [booked, cancelled, receipts, leads, qualified, visits] = await Promise.all([
    db.booking.findMany({ where: { bookedAt: { gte: from, lt: to }, unit: pScope }, select: { bookedAt: true, agreementValue: true } }),
    db.booking.findMany({ where: { cancelledAt: { gte: from, lt: to }, unit: pScope }, select: { cancelledAt: true, agreementValue: true } }),
    db.receipt.findMany({ where: { receivedAt: { gte: from, lt: to }, booking: { unit: pScope } }, select: { receivedAt: true, amount: true } }),
    db.lead.findMany({ where: { createdAt: { gte: from, lt: to }, ...pScope }, select: { createdAt: true } }),
    db.lead.findMany({ where: { qualifiedAt: { gte: from, lt: to }, ...pScope }, select: { qualifiedAt: true } }),
    db.activity.findMany({ where: { type: "SITE_VISIT", scheduledFor: { gte: from, lt: to }, lead: pScope }, select: { scheduledFor: true, leadId: true } }),
  ]);
  const zero = () => Array.from({ length: 13 }, () => 0);
  const a: Record<Exclude<Kpi, "DEFAULT_RATE">, number[]> = { SALES_VALUE: zero(), UNITS: zero(), COLLECTIONS: zero(), SITE_VISITS: zero(), QUALIFIED: zero(), LEADS: zero() };
  for (const b of booked) { const { m } = monthOf(b.bookedAt); a.SALES_VALUE[m] += b.agreementValue; a.UNITS[m] += 1; }
  for (const b of cancelled) { const { m } = monthOf(b.cancelledAt!); a.SALES_VALUE[m] -= b.agreementValue; a.UNITS[m] -= 1; }
  for (const r of receipts) a.COLLECTIONS[monthOf(r.receivedAt).m] += r.amount;
  for (const l of leads) a.LEADS[monthOf(l.createdAt).m] += 1;
  for (const l of qualified) a.QUALIFIED[monthOf(l.qualifiedAt!).m] += 1;
  const seen = new Set<string>();
  for (const v of visits) {
    const { m } = monthOf(v.scheduledFor!);
    const k = `${v.leadId}:${m}`;
    if (!seen.has(k)) { seen.add(k); a.SITE_VISITS[m] += 1; }
  }
  return a;
}

/** Default rate as of a date: unpaid demands more than 90 days past due ÷ all demands raised so far. */
export async function defaultRate(asOf: Date, projectIds: string[] | "ALL", projectId = "") {
  const pScope = projectId ? { projectId } : projectIds === "ALL" ? {} : { projectId: { in: projectIds } };
  const demands = await db.demand.findMany({
    where: { raisedAt: { lte: asOf }, booking: { status: { not: "CANCELLED" }, unit: pScope } },
    select: { amount: true, dueDate: true, receipts: { where: { receivedAt: { lte: asOf } }, select: { amount: true } }, booking: { select: { unit: { select: { project: { select: { name: true } } } } } } },
  });
  const cutoff = asOf.getTime() - 90 * 864e5;
  let invoiced = 0, over90 = 0;
  const byProject = new Map<string, number>();
  for (const d of demands) {
    invoiced += d.amount;
    const unpaid = Math.max(0, d.amount - d.receipts.reduce((s, r) => s + r.amount, 0));
    if (unpaid > 0 && d.dueDate.getTime() < cutoff) {
      over90 += unpaid;
      const p = d.booking.unit.project.name;
      byProject.set(p, (byProject.get(p) ?? 0) + unpaid);
    }
  }
  return { invoiced, over90, pct: invoiced ? (over90 / invoiced) * 100 : 0, byProject: [...byProject.entries()].sort((x, y) => y[1] - x[1]) };
}

export async function yearTargets(year: number, projectId = "") {
  const rows = await db.planTarget.findMany({ where: { year, projectId } });
  const t: Record<Kpi, number[]> = Object.fromEntries(KPIS.map((k) => [k.key, Array.from({ length: 13 }, () => 0)])) as Record<Kpi, number[]>;
  const has: Record<Kpi, boolean> = Object.fromEntries(KPIS.map((k) => [k.key, false])) as Record<Kpi, boolean>;
  for (const r of rows) {
    if (!(r.kpi in t)) continue;
    t[r.kpi as Kpi][r.month] = r.value;
    if (r.value) has[r.kpi as Kpi] = true;
  }
  return { t, has };
}

export type ScoreRow = {
  kpi: Kpi; label: string; unit: "inr" | "count" | "pct"; hint: string;
  month: { actual: number; target: number | null; pct: number | null; rag: Rag };
  ytd: { actual: number; target: number | null; pct: number | null; rag: Rag };
  fy: { target: number | null; estimate: number | null; pct: number | null; rag: Rag };
  series: { actual: number[]; target: number[] };
};

/** The goals scorecard for a month: month, YTD and full-year estimate per KPI. */
export async function scorecard(year: number, month: number, projectIds: string[] | "ALL", projectId = ""): Promise<ScoreRow[]> {
  const [a, { t, has }, dr] = await Promise.all([yearActuals(year, projectIds, projectId), yearTargets(year, projectId), defaultRate(monthEnd(year, month), projectIds, projectId)]);
  const sum = (arr: number[], from: number, to: number) => arr.slice(from, to + 1).reduce((s, x) => s + x, 0);
  return KPIS.map((k) => {
    if (k.key === "DEFAULT_RATE") {
      const target = has.DEFAULT_RATE ? t.DEFAULT_RATE[0] : null;
      const pct = achievement("DEFAULT_RATE", dr.pct, target);
      const cell = { actual: dr.pct, target, pct, rag: ragFor(pct) };
      return { kpi: k.key, label: k.label, unit: k.unit, hint: k.hint, month: cell, ytd: cell, fy: { target, estimate: dr.pct, pct, rag: ragFor(pct) }, series: { actual: [], target: [] } };
    }
    const act = a[k.key], tgt = t[k.key], hasT = has[k.key];
    const mA = act[month], mT = hasT ? tgt[month] : null;
    const yA = sum(act, 1, month), yT = hasT ? sum(tgt, 1, month) : null;
    const fyT = hasT ? sum(tgt, 1, 12) : null;
    // Run-rate estimate: year to date plus the last 3 months' average for each month left.
    const recent = act.slice(Math.max(1, month - 2), month + 1);
    const avg = recent.length ? recent.reduce((s, x) => s + x, 0) / recent.length : 0;
    const fyE = yA + avg * (12 - month);
    const pm = achievement(k.key, mA, mT), py = achievement(k.key, yA, yT), pf = achievement(k.key, fyE, fyT);
    return {
      kpi: k.key, label: k.label, unit: k.unit, hint: k.hint,
      month: { actual: mA, target: mT, pct: pm, rag: ragFor(pm) },
      ytd: { actual: yA, target: yT, pct: py, rag: ragFor(py) },
      fy: { target: fyT, estimate: fyE, pct: pf, rag: ragFor(pf) },
      series: { actual: act.slice(1), target: hasT ? tgt.slice(1) : [] },
    };
  });
}

export function fmtKpi(unit: "inr" | "count" | "pct", v: number | null | undefined) {
  if (v == null) return "–";
  if (unit === "pct") return `${v.toFixed(2)}%`;
  if (unit === "count") return Math.round(v).toLocaleString("en-IN");
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`;
  return `${sign}₹${Math.round(a).toLocaleString("en-IN")}`;
}
