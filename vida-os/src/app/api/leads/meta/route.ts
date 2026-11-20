import { intakeLead } from "@/lib/sales";
import { CORS, json, projectIdFrom } from "../_shared";

/**
 * Simplified Meta lead-ads webhook: { full_name, phone_number, email, project_code, campaign_name }.
 * Meta lead forms include a consent step, so consent time is recorded on receipt.
 * Production: verify Meta's signature header before trusting the payload.
 */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "Send JSON" }, 400);
  }
  try {
    const res = await intakeLead(
      {
        name: String(b.full_name ?? ""),
        phone: String(b.phone_number ?? ""),
        email: b.email ? String(b.email) : null,
        projectId: await projectIdFrom(b.project_code),
        source: "META",
        campaign: b.campaign_name ? String(b.campaign_name) : null,
        consentAt: new Date(),
      },
      null,
    );
    return json({ ok: true, duplicate: res.duplicate });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
