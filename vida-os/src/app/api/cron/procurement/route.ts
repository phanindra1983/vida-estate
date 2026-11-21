import { NextResponse, type NextRequest } from "next/server";
import { runEngine } from "@/lib/procurement";
import { checkInbox, inboxConfigured } from "@/lib/mail-inbox";

export const maxDuration = 60;

/**
 * For a scheduler (for example every 30 minutes): GET /api/cron/procurement?key=CRON_KEY
 * Runs one pass of the procurement engine. Refuses without the key from .env.
 */
export async function GET(req: NextRequest) {
  const key = process.env.CRON_KEY;
  const vercelCron = process.env.CRON_SECRET && req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!vercelCron && (!key || req.nextUrl.searchParams.get("key") !== key)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const mail = inboxConfigured() ? await checkInbox() : null;
  const r = await runEngine();
  return NextResponse.json({ ok: true, ...r, mail });
}
