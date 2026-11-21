import { intakeLead } from "@/lib/sales";
import { announceLead, noteArrival } from "@/lib/lead-intake";
import { CORS, json, projectIdFrom } from "../_shared";

/** Website enquiry form. Consent (DPDP Act) is required. */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "Send JSON" }, 400);
  }
  if (b.consent !== true) return json({ error: "Consent is required to contact you" }, 400);
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
      },
      null,
    );
    await noteArrival("WEBSITE");
    if (!res.duplicate) await announceLead(res.lead.id);
    return json({ ok: true, duplicate: res.duplicate });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
