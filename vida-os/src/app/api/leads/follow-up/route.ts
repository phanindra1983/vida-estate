import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { n8nKeyOk } from "@/lib/n8n";

/**
 * The n8n lead workflow parks a cold lead (score below 50): a follow-up 30 days out, at 11 am IST,
 * so it shows in "Follow-ups due", on the dashboard and in the daily digest when the day comes.
 * An earlier follow-up the sales team already set is never pushed back.
 */
export async function POST(req: Request) {
  if (!n8nKeyOk(req.headers.get("x-vida-key"))) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON" }, { status: 400 });
  }
  const leadId = String(b.leadId ?? "");
  const days = Math.min(90, Math.max(1, Number(b.days) || 30));
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, stage: true, nextFollowUp: true } });
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (["LOST", "BOOKED", "AGREEMENT_SIGNED"].includes(lead.stage)) return NextResponse.json({ set: false, reason: `Lead is ${lead.stage}` });

  const day = new Date(Date.now() + days * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
  const at = new Date(`${day}T11:00:00+05:30`);
  if (lead.nextFollowUp && lead.nextFollowUp > new Date() && lead.nextFollowUp < at)
    return NextResponse.json({ set: false, reason: "An earlier follow-up is already set", nextFollowUp: lead.nextFollowUp });

  const score = Number(b.score);
  const note = `Cold lead${Number.isFinite(score) ? ` (score ${score})` : ""}. I'll connect after ${days} days: follow-up set for ${at.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}.`;
  await db.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUp: at } });
    await tx.activity.create({ data: { leadId: lead.id, type: "SYSTEM", note } });
    await audit(null, "UPDATE", "Lead", lead.id, `${lead.name}: ${days}-day follow-up set by the n8n lead workflow`, { before: { nextFollowUp: lead.nextFollowUp }, after: { nextFollowUp: at } }, tx);
  });
  return NextResponse.json({ set: true, nextFollowUp: at.toISOString() });
}
