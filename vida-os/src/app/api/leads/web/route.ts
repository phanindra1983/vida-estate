import { db } from "@/lib/db";
import { intakeLead } from "@/lib/sales";
import { announceLead, noteArrival } from "@/lib/lead-intake";
import { refreshScore } from "@/lib/lead-score";
import { sendLeadToN8n } from "@/lib/n8n";
import { HOME_TYPES, PURPOSES, TIMELINES } from "@/lib/constants";
import { CORS, json, projectIdFrom } from "../_shared";
import { rateLimit, clientIp, originAllowed, cap, isEmail } from "@/lib/security";

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
  // Only our own website may post, and only at a human pace (per address, per phone, and overall).
  if (process.env.NODE_ENV === "production" && !originAllowed(req.headers.get("origin"))) return json({ error: "Not allowed" }, 403);
  const ip = clientIp(req.headers);
  if (!rateLimit(`web-ip:${ip}`, 5, 10 * 60e3) || !rateLimit("web-all", 60, 10 * 60e3)) return json({ error: "Too many enquiries. Please try again later or call us." }, 429);
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "Send JSON" }, 400);
  }
  if (b.consent !== true) return json({ error: "Consent is required to contact you" }, 400);
  const phoneDigits = cap(b.phone, 20).replace(/\D/g, "").slice(-10);
  if (phoneDigits && !rateLimit(`web-phone:${phoneDigits}`, 3, 60 * 60e3)) return json({ error: "We already have your enquiry. Our team will call you shortly." }, 429);
  const email = cap(b.email, 120);
  if (email && !isEmail(email)) return json({ error: "Please enter a valid email, or leave it empty" }, 400);
  const answers = {
    budget: pick(b.budget, BUDGETS),
    preferredType: pick(b.homeSize, HOME_TYPES),
    purpose: pick(b.purpose, Object.keys(PURPOSES)),
    timeline: pick(b.timeline, Object.keys(TIMELINES)),
  };
  try {
    const res = await intakeLead(
      {
        name: cap(b.name, 80),
        phone: cap(b.phone, 20),
        email: email || null,
        projectId: await projectIdFrom(b.project),
        source: "WEBSITE",
        campaign: [b.campaign, b.utm_source, b.utm_campaign].filter(Boolean).map((x) => cap(x, 60)).join(" · ") || null,
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
    // Only our own plain validation messages go back to the browser, never internal errors.
    const m = (e as Error).message;
    return json({ error: /^(Enter a valid|Name is required)/.test(m) ? m : "Sorry, we could not save that. Please call us." }, 400);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
