import { db } from "@/lib/db";
import { intakeLead } from "@/lib/sales";
import { announceLead, noteArrival } from "@/lib/lead-intake";
import { refreshScore } from "@/lib/lead-score";
import { sendLeadToN8n } from "@/lib/n8n";
import { sendEmail } from "@/lib/notify";
import { HOME_TYPES, PURPOSES, TIMELINES } from "@/lib/constants";
import { CORS, json, projectIdFrom } from "../_shared";

const BUDGETS = ["Under ₹1 Cr", "₹1–2 Cr", "₹2–3 Cr", "₹3 Cr+"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function thankYouText(name: string, project: string | null, day: string | null) {
  const when = day ? ` for ${new Date(day + "T00:00:00+05:30").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}` : "";
  return [
    `Dear ${name.trim().split(/\s+/)[0]},`,
    "",
    `Thank you for your interest in ${project ?? "Vida Estates"}. We have received your site visit request${when}.`,
    "",
    "A Vida advisor will call you within 15 minutes (between 9 am and 8 pm) to confirm the visit. At the site office you can walk the site, see the sample flat and take home the full price sheet.",
    "",
    "Warm regards,",
    "Vida Estates",
    "https://www.vidaestates.co.in",
  ].join("\n");
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
    // Thank the buyer by email straight away (new enquiries only, and only if they gave an email).
    let thankYou = "Not sent (no email)";
    if (lead && !res.duplicate && lead.email && EMAIL.test(lead.email)) {
      const m = await sendEmail(lead.email, "Thank you for your enquiry – Vida Estates", thankYouText(lead.name, lead.project?.name ?? null, day), { type: "Lead", id: lead.id }, { live: true });
      thankYou = m.status === "SENT" ? "Email sent" : `Email ${m.status.toLowerCase()}`;
    } else if (res.duplicate) thankYou = "Not sent (repeat enquiry)";
    if (lead) {
      await sendLeadToN8n({
        leadId: lead.id,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        project: lead.project?.name ?? null,
        budget: lead.budget,
        homeSize: lead.preferredType,
        purpose: lead.purpose,
        timeline: lead.timeline,
        preferredDay: day,
        campaign: lead.campaign,
        score: lead.score,
        duplicate: res.duplicate,
        thankYou,
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
