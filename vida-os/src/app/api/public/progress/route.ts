import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Construction progress for the public website's "Live from site" timeline:
 * every tower milestone of published projects under construction, planned against actual.
 * Only names, dates, percent and status leave the system; no reports, photos or people.
 */
export async function GET() {
  const projects = await db.project.findMany({
    where: { published: true, status: "UNDER_CONSTRUCTION" },
    orderBy: { name: "asc" },
    include: {
      towers: { orderBy: { name: "asc" }, include: { milestones: { orderBy: { seq: "asc" } } } },
      reports: { orderBy: { date: "desc" }, take: 1, select: { date: true } },
    },
  });
  const towers = projects.flatMap((p) =>
    p.towers
      .filter((t) => t.milestones.length)
      .map((t) => ({
        project: p.name,
        tower: t.name,
        lastReport: p.reports[0]?.date ?? null,
        milestones: t.milestones.map((m) => ({
          // "Slab 10 · Tower A" → "Slab 10": the tower is already the tab.
          name: m.name.split(" · ")[0],
          plannedEnd: m.plannedEnd,
          actualEnd: m.status === "DONE" ? m.actualEnd ?? m.plannedEnd : null,
          progressPct: m.status === "DONE" ? 100 : m.progressPct,
          status: m.status === "DONE" ? "DONE" : m.status === "NOT_STARTED" ? "PLANNED" : "UNDER_WAY",
        })),
      })),
  );
  return NextResponse.json(
    { towers, asOf: new Date() },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } },
  );
}
