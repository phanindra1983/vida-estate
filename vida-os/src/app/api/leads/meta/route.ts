import { createHmac, timingSafeEqual } from "node:crypto";
import { keyMatches, parseLead, receiveLead } from "@/lib/lead-intake";
import { CORS, json } from "../_shared";

export const maxDuration = 30;

/**
 * Meta (Facebook / Instagram) Lead Ads.
 *
 * Direct: a Meta app's "leadgen" webhook points here. GET answers Meta's check (the verify
 * token is the META key from Control → Lead sources). POST is checked against
 * x-hub-signature-256 with META_APP_SECRET, then each lead is read from the Graph API with
 * META_PAGE_TOKEN. Both settings are added by the owner in Vercel.
 *
 * Via a tool (Zapier, Make, Pabbly): POST the lead as JSON with ?key=<META key>.
 */
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  if (u.get("hub.mode") === "subscribe" && (await keyMatches("META", u.get("hub.verify_token")))) {
    return new Response(u.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Not allowed", { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const url = new URL(req.url);
  const signature = req.headers.get("x-hub-signature-256");

  if (signature) {
    const secret = process.env.META_APP_SECRET;
    if (!secret) return json({ error: "META_APP_SECRET is not set" }, 503);
    const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(expected), b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: "Bad signature" }, 403);
    const token = process.env.META_PAGE_TOKEN;
    if (!token) return json({ error: "META_PAGE_TOKEN is not set" }, 503);

    const body = JSON.parse(raw) as { entry?: { changes?: { field?: string; value?: { leadgen_id?: string } }[] }[] };
    const ids = (body.entry ?? []).flatMap((e) => e.changes ?? []).filter((c) => c.field === "leadgen" && c.value?.leadgen_id).map((c) => c.value!.leadgen_id!);
    for (const id of ids) {
      try {
        const res = await fetch(`https://graph.facebook.com/${encodeURIComponent(id)}?fields=field_data,campaign_name,ad_name,form_id,created_time&access_token=${encodeURIComponent(token)}`);
        const lead = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
        if (!res.ok || lead.error) throw new Error(lead.error?.message ?? `Graph API ${res.status}`);
        await receiveLead("META", parseLead(lead), { projectCode: url.searchParams.get("project") });
      } catch (e) {
        console.error("Meta lead", id, "could not be saved:", (e as Error).message);
      }
    }
    return json({ ok: true, leads: ids.length }); // always 200, so Meta does not keep retrying
  }

  // Simple JSON from a connector tool: needs the META key.
  if (!(await keyMatches("META", url.searchParams.get("key") ?? req.headers.get("x-vida-key")))) return json({ error: "Not allowed" }, 403);
  try {
    const r = await receiveLead("META", parseLead(JSON.parse(raw)), { projectCode: url.searchParams.get("project") });
    return json({ ok: true, duplicate: r.duplicate });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
