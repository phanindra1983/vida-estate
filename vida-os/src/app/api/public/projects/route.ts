import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Published projects for the public website (R1): live "units left" and starting price. */
export async function GET() {
  const projects = await db.project.findMany({ where: { published: true }, orderBy: { name: "asc" } });
  const data = await Promise.all(projects.map(async (p) => {
    const [left, types] = await Promise.all([
      db.unit.count({ where: { projectId: p.id, OR: [{ status: "AVAILABLE" }, { status: "BLOCKED", blockedUntil: { lt: new Date() } }] } }),
      db.unit.findMany({ where: { projectId: p.id }, distinct: ["type"], select: { type: true } }),
    ]);
    return {
      code: p.code, name: p.name, location: p.location, type: p.type, status: p.status, reraNo: p.reraNo,
      description: p.description, startingPrice: p.startingPrice, unitTypes: types.map((t) => t.type).sort(), unitsLeft: left,
    };
  }));
  return NextResponse.json({ projects: data }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" } });
}
