import { db } from "@/lib/db";
import { intakeLead } from "@/lib/sales";
import { announceLead, noteArrival } from "@/lib/lead-intake";
import { refreshScore } from "@/lib/lead-score";
import { sendLeadToN8n } from "@/lib/n8n";
import { HOME_TYPES, PURPOSES, TIMELINES } from "@/lib/constants";
import { CORS, json, projectIdFrom } from "../_shared";

const BUDGETS = ["Under ₹1 Cr", "₹1–2 Cr", "₹2–3 Cr", "₹3 Cr+"];
/** Answers from the Vida Mars concept page, passed through to n8n for its Mars score. */
const MARS_ANSWERS = { speedSickness: ["Yes", "No"], likesRed: ["Yes", "No"], married: ["Yes", "No"], income: ["Under ₹1 Cr", "₹1–5 Cr", "Above ₹5 Cr"] } as const;
function marsFrom(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out = Object.fromEntries(Object.entries(MARS_ANSWERS).map(([k, allowed]) => [k, pick(o[k], allowed)]));
  return Object.values(out).some(Boolean) ? out : null;
}

/** Only values from the website's own drop-downs are kept; anything else is ignored. */
const pick = (v: unknown, allowed: readonly string[]) => (typeof v === "string" && allowed.includes(v) ? v : null);

/** Website enquiry form. Consent (DPDP Act) is required. */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "Send JSON" }, 400);
  }
  if (b.consent !== true) return json({ error: "Consent is required to contact you" }, 400);
  const answers = {
    budget: pick(b.budget, BUDGETS),
    preferredType: pick(b.homeSize, HOME_TYPES),
    purpose: pick(b.purpose, Object.keys(PURPOSES)),
    timeline: pick(b.timeline, Object.keys(TIMELINES)),
  };
  try {
    const res = await intakeLead(
      {
        name: String(b.name ?? ""),
        phone: String(b.phone ?? ""),
        email: b.email ? String(b.email) : null,
        projectId: await projectIdFrom(b.project),
        source: "WEBSITE",
        campaign: [b.campaign, b.utm_source, b.utm_campaign].filter(Boolean).map(String).join(" · ") || null,
        notes: b.message ? String(b.message).slice(0, 1000) : null,
        consentAt: new Date(),
        ...answers,
      },
      null,
    );
    // A repeat enquiry fills in answers the earlier one left blank, never overwrites them.
    if (res.duplicate) {
      const fill = Object.fromEntries(Object.entries(answers).filter(([k, v]) => v && !res.lead[k as keyof typeof answers]));
      if (Object.keys(fill).length) await db.lead.update({ where: { id: res.lead.id }, data: fill });
    }
    await refreshScore(res.lead.id);
    await noteArrival("WEBSITE");
    if (!res.duplicate) await announceLead(res.lead.id);

    const lead = await db.lead.findUnique({ where: { id: res.lead.id }, include: { project: { select: { name: true } } } });
    const day = typeof b.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : null;
    // The thank-you email is sent by the n8n workflow ("Send Thank-you Email"), not here.
    if (lead) {
      await sendLeadToN8n({
        leadId: lead.id,
        name: lead.name,
        phone: lead.phone,
        email: lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email) ? lead.email : null, // n8n only emails a valid address
        project: lead.project?.name ?? null,
        budget: lead.budget,
        homeSize: lead.preferredType,
        purpose: lead.purpose,
        timeline: lead.timeline,
        preferredDay: day,
        campaign: lead.campaign,
        score: lead.score,
        duplicate: res.duplicate,
        mars: marsFrom(b.mars),
      });
    }
    return json({ ok: true, duplicate: res.duplicate });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
