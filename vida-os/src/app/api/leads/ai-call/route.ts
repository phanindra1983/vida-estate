import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bolnaConfigured, startCall } from "@/lib/bolna";
import { n8nKeyOk } from "@/lib/n8n";

/**
 * The n8n lead workflow asks for an immediate AI (Bolna) call to a hot lead (score above 80).
 * Guarded by the same shared key Vida OS uses to post leads to n8n (header x-vida-key).
 * Skips a lead that is not consented, asked not to be called, or was AI-called in the last 24 hours
 * (so a repeat enquiry or Vida OS's own auto-call does not ring the buyer twice).
 */

export async function POST(req: Request) {
  if (!n8nKeyOk(req.headers.get("x-vida-key"))) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  let leadId = "";
  try {
    leadId = String((await req.json()).leadId ?? "");
  } catch {
    return NextResponse.json({ error: "Send JSON" }, { status: 400 });
  }
  if (!bolnaConfigured()) return NextResponse.json({ called: false, reason: "AI caller not set up" });
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, consentAt: true, doNotCallAt: true, stage: true } });
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (!lead.consentAt) return NextResponse.json({ called: false, reason: "No consent to call" });
  if (lead.doNotCallAt) return NextResponse.json({ called: false, reason: "Asked not to be called" });
  if (["LOST", "BOOKED", "AGREEMENT_SIGNED"].includes(lead.stage)) return NextResponse.json({ called: false, reason: `Lead is ${lead.stage}` });
  // Only calls that actually started count (a call Bolna refused, e.g. an unverified number on a trial account, may be retried).
  const recent = await db.aiCall.findFirst({ where: { leadId, createdAt: { gte: new Date(Date.now() - 864e5) }, status: { not: "FAILED_TO_START" } }, select: { id: true } });
  if (recent) return NextResponse.json({ called: false, reason: "Already AI-called in the last 24 hours" });
  try {
    const callId = await startCall({ leadId, trigger: "AUTO" });
    return NextResponse.json({ called: true, callId });
  } catch (e) {
    return NextResponse.json({ called: false, reason: (e as Error).message.slice(0, 200) });
  }
}
