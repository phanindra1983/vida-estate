import { NextResponse, type NextRequest } from "next/server";
import { runEngine } from "@/lib/procurement";

/**
 * For a scheduler (for example every 30 minutes): GET /api/cron/procurement?key=CRON_KEY
 * Runs one pass of the procurement engine. Refuses without the key from .env.
 */
export async function GET(req: NextRequest) {
  const key = process.env.CRON_KEY;
  if (!key || req.nextUrl.searchParams.get("key") !== key) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const r = await runEngine();
  return NextResponse.json({ ok: true, ...r });
}
