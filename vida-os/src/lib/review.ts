import { db } from "./db";
import { projectSnapshot } from "./mis";
import { monthStart, monthEnd, fmtKpi, type ScoreRow } from "./performance";

/** Data for the monthly Business Review (BRM) sections, beyond the goals scorecard. */

const DAY = 864e5;

/** Project execution status: cost, sales, collections, procurement, plan vs actual, RERA buffer. */
export async function projectExecution(projectIds: string[] | "ALL") {
  const snaps = await projectSnapshot(projectIds);
  const now = Date.now();
  return Promise.all(snaps.filter((s) => s.project.status !== "PLANNING" || s.salesValue > 0).map(async (s) => {
    const [tsv, milestones] = await Promise.all([
      db.unit.aggregate({ where: { projectId: s.project.id }, _sum: { price: true } }),
      db.milestone.findMany({ where: { projectId: s.project.id }, select: { plannedStart: true, plannedEnd: true, progressPct: true, status: true } }),
    ]);
    const planned = milestones.length
      ? (milestones.reduce((a, m) => {
          const span = Math.max(1, m.plannedEnd.getTime() - m.plannedStart.getTime());
          return a + Math.min(1, Math.max(0, (now - m.plannedStart.getTime()) / span));
        }, 0) / milestones.length) * 100
      : null;
    const actual = milestones.length ? milestones.reduce((a, m) => a + (m.status === "DONE" ? 100 : m.progressPct), 0) / milestones.length : null;
    const devCost = s.budget.total;
    const rera = s.project.reraCompletion, est = s.project.estCompletion;
    return {
      id: s.project.id, name: s.project.name, status: s.project.status,
      devCost, tsv: tsv._sum.price ?? 0, sold: s.salesValue, collected: s.collected, committed: s.budget.committed, spent: s.budget.actual,
      finClosure: devCost ? s.salesValue / devCost : null,
      collClosure: devCost ? s.collected / devCost : null,
      procurementPct: devCost ? (s.budget.committed / devCost) * 100 : null,
      planned, actual, variance: planned != null && actual != null ? actual - planned : null,
      rera, est, bufferDays: rera && est ? Math.round((rera.getTime() - est.getTime()) / DAY) : null,
      delayed: s.schedule.delayed.length,
      overdue: s.overdue,
    };
  }));
}

/** Multiple-of-cost status, as in a developer's execution review: 🟢 ≥ 1x · 🟡 0.8–1x · 🔴 < 0.8x. */
export const xRag = (x: number | null) => (x == null ? "⚪" : x >= 1 ? "🟢" : x >= 0.8 ? "🟡" : "🔴");

/** Monthly collections for the year, for the trend chart. Index 1..12. */
export async function collectionsTrend(year: number, projectIds: string[] | "ALL") {
  const pScope = projectIds === "ALL" ? {} : { projectId: { in: projectIds } };
  const rows = await db.receipt.findMany({ where: { receivedAt: { gte: monthStart(year, 1), lt: monthStart(year + 1, 1) }, booking: { unit: pScope } }, select: { receivedAt: true, amount: true } });
  const out = Array.from({ length: 13 }, () => 0);
  for (const r of rows) out[Number(r.receivedAt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-")[1])] += r.amount;
  return out;
}

/** Available inventory: buckets, ageing (from launch), by type, on hold, and this month's movement. */
export async function inventoryDashboard(year: number, month: number, projectIds: string[] | "ALL") {
  const pWhere = projectIds === "ALL" ? {} : { projectId: { in: projectIds } };
  const from = monthStart(year, month), to = monthEnd(year, month);
  const [units, soldInMonth, cancelledInMonth] = await Promise.all([
    db.unit.findMany({ where: { ...pWhere, status: { in: ["AVAILABLE", "BLOCKED"] } }, select: { price: true, type: true, status: true, blockedUntil: true, project: { select: { name: true, launchDate: true, status: true } } } }),
    db.booking.findMany({ where: { bookedAt: { gte: from, lt: to }, unit: pWhere }, select: { agreementValue: true, unit: { select: { price: true } } } }),
    db.booking.findMany({ where: { cancelledAt: { gte: from, lt: to }, unit: pWhere }, select: { unit: { select: { price: true } } } }),
  ]);
  const sellable = units.filter((u) => u.project.status !== "PLANNING");
  const notLaunched = units.filter((u) => u.project.status === "PLANNING");
  const sum = (xs: { price: number }[]) => xs.reduce((s, u) => s + u.price, 0);
  const ageYears = (d: Date | null) => (d ? (Date.now() - d.getTime()) / (365 * DAY) : 0);
  const byProject = new Map<string, { units: number; value: number; age: number }>();
  for (const u of sellable) {
    const r = byProject.get(u.project.name) ?? { units: 0, value: 0, age: ageYears(u.project.launchDate) };
    r.units++; r.value += u.price;
    byProject.set(u.project.name, r);
  }
  const bucket = (lo: number, hi: number) => sellable.filter((u) => { const a = ageYears(u.project.launchDate); return a >= lo && a < hi; });
  const ageing = [
    { label: "Under 1 year", list: bucket(0, 1) },
    { label: "1–3 years", list: bucket(1, 3) },
    { label: "3+ years", list: bucket(3, 999) },
  ].map((b) => ({ label: b.label, units: b.list.length, value: sum(b.list) }));
  const types = [...new Set(sellable.map((u) => u.type))].sort().map((t) => {
    const l = sellable.filter((u) => u.type === t);
    return { type: t, units: l.length, value: sum(l) };
  });
  const onHold = sellable.filter((u) => u.status === "BLOCKED" && u.blockedUntil && u.blockedUntil.getTime() > Date.now());
  const closing = { units: sellable.length, value: sum(sellable) };
  const sold = { units: soldInMonth.length, value: soldInMonth.reduce((s, b) => s + b.unit.price, 0) };
  const back = { units: cancelledInMonth.length, value: cancelledInMonth.reduce((s, b) => s + b.unit.price, 0) };
  return {
    total: closing,
    notLaunched: { units: notLaunched.length, value: sum(notLaunched) },
    onHold: { units: onHold.length, value: sum(onHold) },
    byProject: [...byProject.entries()].map(([name, r]) => ({ name, ...r })).sort((a, b) => b.value - a.value),
    ageing, types,
    movement: { opening: { units: closing.units + sold.units - back.units, value: closing.value + sold.value - back.value }, sold, cancelled: back, closing },
  };
}

/** Sales by project YTD, ticket size vs last year, and cancellations YTD. */
export async function salesUpdate(year: number, month: number, projectIds: string[] | "ALL") {
  const pWhere = projectIds === "ALL" ? {} : { projectId: { in: projectIds } };
  const ytd = (y: number) => ({ gte: monthStart(y, 1), lt: monthEnd(y, month) });
  const [thisYear, lastYear, cancelled] = await Promise.all([
    db.booking.findMany({ where: { bookedAt: ytd(year), unit: pWhere }, select: { agreementValue: true, unit: { select: { project: { select: { name: true } } } } } }),
    db.booking.findMany({ where: { bookedAt: ytd(year - 1), unit: pWhere }, select: { agreementValue: true } }),
    db.booking.findMany({ where: { cancelledAt: ytd(year), unit: pWhere }, select: { agreementValue: true, unit: { select: { project: { select: { name: true } } } } } }),
  ]);
  const group = (rows: { agreementValue: number; unit: { project: { name: string } } }[]) => {
    const m = new Map<string, { units: number; value: number }>();
    for (const r of rows) {
      const g = m.get(r.unit.project.name) ?? { units: 0, value: 0 };
      g.units++; g.value += r.agreementValue;
      m.set(r.unit.project.name, g);
    }
    return [...m.entries()].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.value - a.value);
  };
  const total = thisYear.reduce((s, b) => s + b.agreementValue, 0);
  const totalLY = lastYear.reduce((s, b) => s + b.agreementValue, 0);
  return {
    byProject: group(thisYear), total,
    units: thisYear.length, ticket: thisYear.length ? total / thisYear.length : 0,
    unitsLY: lastYear.length, ticketLY: lastYear.length ? totalLY / lastYear.length : 0,
    cancellations: group(cancelled), cancelledValue: cancelled.reduce((s, b) => s + b.agreementValue, 0),
  };
}

/** The automatic half of the executive summary; people add their own lines and actions. */
export function autoSummary(score: ScoreRow[], exec: Awaited<ReturnType<typeof projectExecution>>, inv: Awaited<ReturnType<typeof inventoryDashboard>>, pendingApprovals: number) {
  const worked: string[] = [], notWorked: string[] = [], concerns: string[] = [];
  for (const r of score) {
    if (r.ytd.target == null) continue;
    const line = `${r.label}: ${fmtKpi(r.unit, r.ytd.actual)} vs plan ${fmtKpi(r.unit, r.ytd.target)} year to date (${Math.round(r.ytd.pct ?? 0)}%)`;
    if (r.ytd.rag === "GREEN") worked.push(line);
    else if (r.ytd.rag === "RED" || r.ytd.rag === "AMBER") notWorked.push(line);
  }
  for (const p of exec) {
    if (p.variance != null && p.variance < -3) concerns.push(`${p.name}: construction ${Math.abs(p.variance).toFixed(1)}% behind plan (${p.delayed} stage${p.delayed === 1 ? "" : "s"} late)`);
    else if (p.variance != null && p.variance >= 0 && p.planned) worked.push(`${p.name}: construction on or ahead of plan (${p.actual?.toFixed(1)}% done vs ${p.planned.toFixed(1)}% planned)`);
    if (p.bufferDays != null && p.bufferDays < 90) concerns.push(`${p.name}: only ${p.bufferDays} days of buffer to the RERA date`);
    if (p.rera == null && p.status === "UNDER_CONSTRUCTION") concerns.push(`${p.name}: RERA completion date not entered, so the buffer can't be tracked`);
    if (p.finClosure != null && p.finClosure < 0.8 && p.status === "UNDER_CONSTRUCTION") concerns.push(`${p.name}: sales cover only ${p.finClosure.toFixed(2)}x of development cost`);
  }
  const old = inv.ageing.find((a) => a.label === "3+ years");
  if (old && old.units) concerns.push(`${old.units} unsold units are 3+ years old (${fmtKpi("inr", old.value)})`);
  if (pendingApprovals) concerns.push(`${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting more than 3 days`);
  return { worked, notWorked, concerns };
}
