import { sourceForSlug, keyMatches, parseLead, receiveLead } from "@/lib/lead-intake";
import { publicError } from "@/lib/security";
import { json } from "../../_shared";

export const maxDuration = 30;

/**
 * Lead push from property portals and other platforms:
 *   POST /api/leads/in/<99acres|magicbricks|housing|nobroker|squareyards|meta|google|other>?key=<key>[&project=<code>]
 * The key is on Control → Lead sources (also accepted as the x-vida-key header).
 * Body: JSON (one lead, a list, or { leads: [...] }) or a form post, with the platform's own field names.
 */
export async function POST(req: Request, { params }: { params: Promise<{ source: string }> }) {
  const { source: slug } = await params;
  const source = sourceForSlug(slug);
  if (!source) return json({ error: "Unknown lead source" }, 404);
  const url = new URL(req.url);
  if (!(await keyMatches(source, url.searchParams.get("key") ?? req.headers.get("x-vida-key")))) return json({ error: "Not allowed" }, 403);

  let body: unknown;
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) body = await req.json();
    else if (type.includes("form")) body = Object.fromEntries((await req.formData()).entries());
    else {
      const text = await req.text();
      try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); }
    }
  } catch {
    return json({ error: "Could not read the lead" }, 400);
  }
  const list = (Array.isArray(body) ? body : Array.isArray((body as { leads?: unknown[] })?.leads) ? (body as { leads: unknown[] }).leads : [body]) as Record<string, unknown>[];
  if (list.length > 200) return json({ error: "Send at most 200 leads at a time" }, 400);

  const results = [];
  for (const raw of list) {
    try {
      const r = await receiveLead(source, parseLead(raw ?? {}), { projectCode: url.searchParams.get("project") });
      results.push({ ok: true, duplicate: r.duplicate, id: r.lead.id });
    } catch (e) {
      results.push({ ok: false, error: publicError(e) });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  return json({ ok: ok > 0, received: list.length, saved: ok, results }, ok > 0 || list.length === 0 ? 200 : 400);
}
