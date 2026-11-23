import { keyMatches, parseLead, receiveLead, noteArrival } from "@/lib/lead-intake";
import { publicError } from "@/lib/security";
import { json } from "../_shared";

export const maxDuration = 30;

/**
 * Google Ads lead form webhook. In the lead form, set the webhook URL to
 * /api/leads/google[?project=<code>] and the key to the GOOGLE key from Control → Lead sources.
 * Google sends { lead_id, user_column_data: [{ column_id, string_value }], google_key, is_test, campaign_id, ... }.
 */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "Send JSON" }, 400);
  }
  if (!(await keyMatches("GOOGLE", String(b.google_key ?? "")))) return json({ error: "Not allowed" }, 403);
  if (b.is_test === true) {
    await noteArrival("GOOGLE", true);
    return json({ ok: true, test: true });
  }
  const url = new URL(req.url);
  const p = parseLead({ user_column_data: b.user_column_data });
  if (!p.campaign && b.campaign_id) p.campaign = `Google campaign ${b.campaign_id}`;
  try {
    const r = await receiveLead("GOOGLE", p, { projectCode: url.searchParams.get("project") });
    return json({ ok: true, duplicate: r.duplicate });
  } catch (e) {
    return json({ error: publicError(e) }, 400);
  }
}
