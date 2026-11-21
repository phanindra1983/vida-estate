import { NextResponse, type NextRequest } from "next/server";
import { sendDigest } from "@/lib/digest";

export const maxDuration = 60;

/**
 * Telegram morning plan and evening summary. Vercel cron calls
 * /api/cron/digest?kind=morning|evening with Authorization: Bearer CRON_SECRET;
 * anything else needs ?key=CRON_KEY.
 */
export async function GET(req: NextRequest) {
  const key = process.env.CRON_KEY;
  const vercelCron = process.env.CRON_SECRET && req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!vercelCron && (!key || req.nextUrl.searchParams.get("key") !== key)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const kind = req.nextUrl.searchParams.get("kind") === "evening" ? "evening" : "morning";
  return NextResponse.json({ ok: true, kind, ...(await sendDigest(kind)) });
}
