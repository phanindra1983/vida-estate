import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorized } from "@/lib/security";
import { sendDigest } from "@/lib/digest";
import { refreshAllScores } from "@/lib/lead-score";

export const maxDuration = 60;

/**
 * Telegram morning plan and evening summary. Vercel cron calls
 * /api/cron/digest?kind=morning|evening with Authorization: Bearer CRON_SECRET;
 * anything else needs ?key=CRON_KEY.
 */
export async function GET(req: NextRequest) {
  // Vercel cron only: Authorization: Bearer CRON_SECRET (constant-time check). The old ?key=CRON_KEY is no longer accepted.
  if (!cronAuthorized(req.headers)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const kind = req.nextUrl.searchParams.get("kind") === "evening" ? "evening" : "morning";
  // Each morning, quiet leads cool down before the team sees the lists.
  const scored = kind === "morning" ? await refreshAllScores().catch(() => 0) : 0;
  return NextResponse.json({ ok: true, kind, scored, ...(await sendDigest(kind)) });
}
