import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { fetchRecording } from "@/lib/bolna";
import { CALL_ROLES, callScope } from "@/app/(app)/sales/calls/_shared";

export const dynamic = "force-dynamic";

/** Plays one AI call recording to signed-in sales staff who may see that call. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await getUser();
  if (!u || !CALL_ROLES.includes(u.role)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const { id } = await params;
  const call = await db.aiCall.findFirst({ where: { AND: [{ id }, callScope(u)] }, select: { recordingUrl: true } });
  if (!call?.recordingUrl) return NextResponse.json({ error: "No recording" }, { status: 404 });
  const r = await fetchRecording(call.recordingUrl);
  if (!r.ok || !r.body) return NextResponse.json({ error: "Recording not available yet" }, { status: 502 });
  return new Response(r.body, {
    headers: { "Content-Type": r.headers.get("content-type") ?? "audio/wav", "Cache-Control": "private, max-age=3600" },
  });
}
