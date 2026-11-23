import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorized } from "@/lib/security";
import { runEngine } from "@/lib/procurement";
import { checkInbox, inboxConfigured } from "@/lib/mail-inbox";

export const maxDuration = 60;

/**
 * For a scheduler (for example every 30 minutes): GET /api/cron/procurement?key=CRON_KEY
 * Runs one pass of the procurement engine. Refuses without the key from .env.
 */
export async function GET(req: NextRequest) {
  // For Vercel cron only: Authorization: Bearer CRON_SECRET (constant-time check). The old ?key=CRON_KEY is no longer accepted.
  if (!cronAuthorized(req.headers)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const mail = inboxConfigured() ? await checkInbox() : null;
  // ?only=mail checks the supplier mailbox without running the buying engine.
  if (req.nextUrl.searchParams.get("only") === "mail") return NextResponse.json({ ok: true, mail });
  const r = await runEngine();
  return NextResponse.json({ ok: true, ...r, mail });
}
