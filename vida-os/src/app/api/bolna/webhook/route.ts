import { NextResponse, type NextRequest } from "next/server";
import { webhookKeyMatches, syncExecution } from "@/lib/bolna";

export const dynamic = "force-dynamic";

/**
 * Bolna posts here as a call moves through its statuses (URL carries our key: ?key=...).
 * Bolna does not sign webhooks, so the body is only used for the call id: the call itself
 * is re-read from Bolna's API with our own key before anything is saved.
 */
export async function POST(req: NextRequest) {
  if (!(await webhookKeyMatches(req.nextUrl.searchParams.get("key")))) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  let id = "";
  try {
    const b = (await req.json()) as { id?: string; execution_id?: string };
    id = String(b.id ?? b.execution_id ?? "");
  } catch {}
  if (!/^[\w-]{8,80}$/.test(id)) return NextResponse.json({ ok: true, ignored: "no call id" });
  try {
    const c = await syncExecution(id);
    return NextResponse.json({ ok: true, known: !!c });
  } catch (e) {
    console.error("bolna webhook", e);
    return NextResponse.json({ ok: false, error: "Could not read the call" }, { status: 502 });
  }
}
