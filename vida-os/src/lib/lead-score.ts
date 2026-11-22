import { db } from "./db";

/**
 * Lead score, 0–100, rules a salesperson can read (not a black box).
 * Hot ≥ 60 · Warm ≥ 30 · Cold below. Stored on Lead.score so lists sort and filter by it;
 * refreshed whenever something happens to the lead, and every morning for decay.
 */
export const HOT = 60;
export const WARM = 30;

export type Temp = "HOT" | "WARM" | "COLD";
export const temperature = (score: number): Temp => (score >= HOT ? "HOT" : score >= WARM ? "WARM" : "COLD");
export const TEMP: Record<Temp, { label: string; tone: "bad" | "warn" | "neutral"; icon: string }> = {
  HOT: { label: "Hot", tone: "bad", icon: "🔥" },
  WARM: { label: "Warm", tone: "warn", icon: "🌤" },
  COLD: { label: "Cold", tone: "neutral", icon: "❄️" },
};

const SOURCE_POINTS: Record<string, number> = {
  REFERRAL: 20, WALK_IN: 20, CHANNEL_PARTNER: 18, WEBSITE: 15, WHATSAPP: 15, STAFF: 12, TELEGRAM: 12,
  "99ACRES": 10, MAGICBRICKS: 10, HOUSING: 10, NOBROKER: 8, SQUAREYARDS: 10, OTHER_PORTAL: 8, META: 8, GOOGLE: 10,
};
const STAGE_POINTS: Record<string, number> = { NEW: 0, CONTACTED: 5, QUALIFIED: 15, VISIT_SCHEDULED: 20, VISIT_DONE: 30, NEGOTIATION: 40, UNIT_BLOCKED: 45, BOOKED: 50, AGREEMENT_SIGNED: 50 };
const TIMELINE_POINTS: Record<string, number> = { NOW: 15, "3M": 12, "6M": 6, "12M": 2, LATER: -5 };
const INTEREST_POINTS: Record<string, number> = { INTERESTED: 25, MAYBE: 8, CALL_BACK: 4, NOT_INTERESTED: -35, WRONG_NUMBER: -60, DO_NOT_CALL: -60 };

type ScoreInput = {
  source: string; stage: string; budget: string | null; preferredType: string | null; purpose: string | null; timeline: string | null;
  duplicateCount: number; qualifiedAt: Date | null; lastActivityAt: Date | null; createdAt: Date; doNotCallAt: Date | null;
  aiInterest?: string | null; talked?: boolean;
};

/** Score plus the reasons, so the lead page can show why. */
export function scoreLead(l: ScoreInput) {
  const why: [string, number][] = [];
  const add = (label: string, n: number) => n && why.push([label, n]);
  if (l.stage === "LOST") return { score: 0, why: [["Lost", 0]] as [string, number][] };
  add("Source", SOURCE_POINTS[l.source] ?? 8);
  add("Stage", STAGE_POINTS[l.stage] ?? 0);
  if (l.qualifiedAt) add("Qualified", 10);
  if (l.budget) add("Budget known", 6);
  if (l.preferredType) add("Home size known", 4);
  if (l.purpose) add("Purpose known", 3);
  if (l.timeline) add("Timeline", TIMELINE_POINTS[l.timeline] ?? 0);
  if (l.aiInterest) add("Last call", INTEREST_POINTS[l.aiInterest] ?? 0);
  else if (l.talked) add("Spoke on a call", 5);
  if (l.duplicateCount) add("Enquired again", Math.min(10, l.duplicateCount * 5));
  const idleDays = Math.floor((Date.now() - (l.lastActivityAt ?? l.createdAt).getTime()) / 864e5);
  if (idleDays > 7) add("No activity", -Math.min(25, idleDays - 7));
  if (l.doNotCallAt) add("Asked not to call", -20);
  const score = Math.max(0, Math.min(100, why.reduce((a, [, n]) => a + n, 0)));
  return { score, why };
}

async function inputFor(leadId: string) {
  const [lead, call] = await Promise.all([
    db.lead.findUnique({ where: { id: leadId } }),
    db.aiCall.findFirst({ where: { leadId, OR: [{ interest: { not: null } }, { status: "completed", durationSec: { gt: 0 } }] }, orderBy: { createdAt: "desc" }, select: { interest: true, durationSec: true } }),
  ]);
  if (!lead) return null;
  const humanCall = await db.activity.findFirst({ where: { leadId, type: "CALL" }, select: { id: true } });
  return { lead, input: { ...lead, aiInterest: call?.interest ?? null, talked: !!humanCall || (call?.durationSec ?? 0) > 0 } };
}

export async function explainScore(leadId: string) {
  const r = await inputFor(leadId);
  return r ? scoreLead(r.input) : null;
}

/** Recompute and store one lead's score. Never throws. */
export async function refreshScore(leadId: string) {
  try {
    const r = await inputFor(leadId);
    if (!r) return;
    const { score } = scoreLead(r.input);
    if (score !== r.lead.score) await db.lead.update({ where: { id: leadId }, data: { score } });
  } catch {}
}

/** Every open lead, e.g. each morning so quiet leads cool down. */
export async function refreshAllScores() {
  const leads = await db.lead.findMany({ where: { stage: { notIn: ["BOOKED", "AGREEMENT_SIGNED"] } }, select: { id: true } });
  for (let i = 0; i < leads.length; i += 20) await Promise.all(leads.slice(i, i + 20).map((l) => refreshScore(l.id)));
  return leads.length;
}
