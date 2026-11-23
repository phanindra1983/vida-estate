import { db } from "@/lib/db";
import { publicError } from "@/lib/security";
import { keyMatches } from "@/lib/lead-intake";
import { ACCOUNTS_SOURCE } from "@/lib/accounts";
import { json } from "../../leads/_shared";

export const maxDuration = 60;

type In = {
  areaKey?: string; area?: string; kind?: string; name?: string; cluster?: string; sector?: string;
  kmFromSite?: number; fitScore?: number; employersMapped?: number; reviewVolume?: number; jobPosts?: number;
  medianCtcLakh?: number; topEmployers?: string | string[]; evidence?: string;
};

const num = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const int = (v: unknown) => { const n = num(v); return n === null ? null : Math.round(n); };
const str = (v: unknown, max = 300) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);

/**
 * Monthly push of employer clusters / employers from the micromarket dashboard:
 *   POST /api/accounts/in?key=<key>   (or header x-vida-key)
 *   Body: { accounts: [ { areaKey, area, kind, name, cluster, sector, kmFromSite, fitScore, ... } ] }
 * Upserts by area + name. Market figures are refreshed; the sales team's status, note, owner and
 * follow-up are never overwritten.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!(await keyMatches(ACCOUNTS_SOURCE, url.searchParams.get("key") ?? req.headers.get("x-vida-key")))) return json({ error: "Not allowed" }, 403);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "Send JSON" }, 400); }
  const list = (Array.isArray(body) ? body : (body as { accounts?: unknown[] })?.accounts) as In[] | undefined;
  if (!Array.isArray(list)) return json({ error: "Send { accounts: [...] }" }, 400);
  if (list.length > 500) return json({ error: "Send at most 500 accounts at a time" }, 400);

  let created = 0, updated = 0;
  const errors: string[] = [];
  const now = new Date();
  for (const a of list) {
    const name = str(a.name, 160), areaKey = str(a.areaKey, 60), area = str(a.area, 160) ?? areaKey;
    if (!name || !areaKey) { errors.push("Each account needs name and areaKey"); continue; }
    const key = `${areaKey}|${name.toLowerCase()}`;
    const data = {
      area: area!, areaKey, kind: (str(a.kind, 20) ?? "CLUSTER").toUpperCase(), name,
      cluster: str(a.cluster, 160), sector: str(a.sector, 80),
      kmFromSite: num(a.kmFromSite), fitScore: int(a.fitScore), employersMapped: int(a.employersMapped),
      reviewVolume: int(a.reviewVolume), jobPosts: int(a.jobPosts), medianCtcLakh: num(a.medianCtcLakh),
      topEmployers: Array.isArray(a.topEmployers) ? a.topEmployers.slice(0, 12).join(", ").slice(0, 600) : str(a.topEmployers, 600),
      evidence: str(a.evidence, 600), lastSeenAt: now,
    };
    try {
      const existing = await db.corporateAccount.findUnique({ where: { key }, select: { id: true } });
      if (existing) { await db.corporateAccount.update({ where: { key }, data }); updated++; }
      else { await db.corporateAccount.create({ data: { key, ...data } }); created++; }
    } catch (e) {
      errors.push(`${name}: ${publicError(e)}`);
    }
  }
  return json({ ok: created + updated > 0, received: list.length, created, updated, errors: errors.slice(0, 20) }, created + updated > 0 || list.length === 0 ? 200 : 400);
}
