import { randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { intakeLead } from "./sales";
import { LEAD_SOURCES } from "./constants";
import { send, esc, notifyRoles } from "./telegram";
import { autoCallNewLead } from "./bolna";

/**
 * Leads arriving from ad platforms and property portals.
 * Each source has its own secret key (kept in the Setting table, shown to the MD on
 * Control → Lead sources) that the platform sends with every lead.
 */

/** Sources that push leads to /api/leads/in/<slug>. */
export const PUSH_SOURCES: { slug: string; source: string }[] = [
  { slug: "99acres", source: "99ACRES" },
  { slug: "magicbricks", source: "MAGICBRICKS" },
  { slug: "housing", source: "HOUSING" },
  { slug: "nobroker", source: "NOBROKER" },
  { slug: "squareyards", source: "SQUAREYARDS" },
  { slug: "meta", source: "META" },
  { slug: "google", source: "GOOGLE" },
  { slug: "other", source: "OTHER_PORTAL" },
];
export const sourceForSlug = (slug: string) => PUSH_SOURCES.find((s) => s.slug === slug.toLowerCase())?.source ?? null;

const keyName = (source: string) => `leads.key.${source}`;

/** The source's key, made on first use. */
export async function sourceKey(source: string) {
  const k = await db.setting.findUnique({ where: { key: keyName(source) } });
  if (k) return k.value;
  const value = randomBytes(18).toString("base64url");
  await db.setting.upsert({ where: { key: keyName(source) }, create: { key: keyName(source), value }, update: {} });
  return (await db.setting.findUniqueOrThrow({ where: { key: keyName(source) } })).value;
}

export async function rotateSourceKey(source: string) {
  await db.setting.deleteMany({ where: { key: keyName(source) } });
  return sourceKey(source);
}

export async function keyMatches(source: string, given: string | null | undefined) {
  if (!given) return false;
  const k = await db.setting.findUnique({ where: { key: keyName(source) } });
  if (!k) return false;
  const a = Buffer.from(k.value), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ───────────── reading a lead in whatever shape the platform sends ─────────────

const FIELDS = {
  name: ["name", "full_name", "fullname", "contact_name", "contactname", "customer_name", "buyer_name", "lead_name", "leadname", "client_name", "sender_name", "user_name"],
  first: ["first_name", "firstname", "fname"],
  last: ["last_name", "lastname", "lname"],
  phone: ["phone", "phone_number", "phonenumber", "mobile", "mobile_no", "mobileno", "mobile_number", "mobilenumber", "contact_no", "contactno", "contact_number", "contactnumber", "phoneno", "phone_no", "cell", "isd_mobile", "sender_mobile", "user_mobile"],
  email: ["email", "email_id", "emailid", "email_address", "contact_email", "sender_email", "user_email"],
  project: ["project", "project_code", "project_name", "projectname", "property", "property_name", "propertyname", "prop_name", "listing", "listing_name", "society", "project_title"],
  message: ["message", "msg", "query", "queries", "comments", "comment", "requirement", "remarks", "enquiry", "inquiry", "details", "description", "qrydtl", "query_details", "query_detail", "enquiry_details"],
  campaign: ["campaign", "campaign_name", "utm_campaign", "ad_name", "adset_name", "form_name", "sub_source", "subsource"],
  type: ["bhk", "unit_type", "configuration", "property_type"],
  budget: ["budget", "price_range", "budget_range"],
} as const;

const norm = (k: string) => k.toLowerCase().replace(/[\s.-]+/g, "_");

/** Flatten one level of nesting ({ lead: {...} }) and Meta/Google-style field arrays into one flat map. */
function flatten(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v == null || v === "") return;
    if (Array.isArray(v)) v = v[0];
    if (typeof v === "object") return;
    const key = norm(k);
    if (!(key in out)) out[key] = String(v).trim();
  };
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.every((x) => x && typeof x === "object")) {
      // [{ name: "full_name", values: ["..."] }] (Meta) or [{ column_id: "FULL_NAME", string_value: "..." }] (Google)
      for (const f of v as Record<string, unknown>[]) {
        const fk = (f.name ?? f.column_id ?? f.column_name ?? f.key ?? f.field) as string | undefined;
        const fv = f.values ?? f.string_value ?? f.value;
        if (fk) put(fk, fv);
      }
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) put(k2, v2);
    } else put(k, v);
  }
  return out;
}

const pick = (f: Record<string, string>, keys: readonly string[]) => {
  for (const k of keys) if (f[k]) return f[k];
  return "";
};

export type ParsedLead = { name: string; phone: string; email: string | null; projectHint: string; notes: string | null; campaign: string | null; preferredType: string | null };

export function parseLead(raw: Record<string, unknown>): ParsedLead {
  const f = flatten(raw);
  const name = pick(f, FIELDS.name) || [pick(f, FIELDS.first), pick(f, FIELDS.last)].filter(Boolean).join(" ");
  const extra = [pick(f, FIELDS.message), pick(f, FIELDS.budget) && `Budget: ${pick(f, FIELDS.budget)}`].filter(Boolean).join("\n");
  return {
    name: name.slice(0, 120),
    phone: pick(f, FIELDS.phone),
    email: pick(f, FIELDS.email) || null,
    projectHint: pick(f, FIELDS.project),
    notes: extra ? extra.slice(0, 1000) : null,
    campaign: pick(f, FIELDS.campaign) || null,
    preferredType: pick(f, FIELDS.type) || null,
  };
}

/** Find the project from a code, or a project name anywhere in the text (e.g. "Vida Aurum 3BHK, Kokapet"). */
export async function matchProject(...hints: (string | null | undefined)[]) {
  const text = hints.filter(Boolean).join(" ").toLowerCase();
  if (!text) return null;
  const projects = await db.project.findMany({ select: { id: true, code: true, name: true } });
  const byName = projects.filter((p) => text.includes(p.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
  if (byName) return byName.id;
  // A distinctive word of the name on its own ("Aurum" for "Vida Aurum"), if only one project has it.
  const COMMON = new Set(["vida", "estates", "the", "by", "at", "residency", "homes", "towers", "phase"]);
  const textWords = new Set(text.split(/[^a-z0-9]+/));
  const byWord = projects.filter((p) => p.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && !COMMON.has(w) && textWords.has(w)));
  if (byWord.length === 1) return byWord[0].id;
  const words = new Set(text.toUpperCase().split(/[^A-Z0-9]+/));
  return projects.find((p) => words.has(p.code.toUpperCase()))?.id ?? null;
}

/** Save one lead from a platform, record its arrival, and tell the salesperson. */
export async function receiveLead(source: string, p: ParsedLead, opts: { projectCode?: string | null; consent?: boolean } = {}) {
  const projectId = await matchProject(opts.projectCode, p.projectHint, p.campaign);
  const res = await intakeLead(
    { name: p.name, phone: p.phone, email: p.email, projectId, source, campaign: p.campaign, notes: [p.projectHint && `Enquired about: ${p.projectHint}`, p.notes].filter(Boolean).join("\n") || null, preferredType: p.preferredType, consentAt: opts.consent === false ? null : new Date() },
    null,
  );
  await noteArrival(source);
  if (!res.duplicate) await announceLead(res.lead.id);
  return res;
}

export async function noteArrival(source: string, test = false) {
  const key = `leads.last.${source}`;
  const value = JSON.stringify({ at: new Date().toISOString(), test });
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** Telegram: the assigned salesperson (or the sales managers, if nobody is assigned) hears at once. Then the AI caller, if on. */
export async function announceLead(leadId: string) {
  try {
    const lead = await db.lead.findUnique({ where: { id: leadId }, include: { project: true } });
    if (!lead) return;
    const text = `📞 <b>New lead</b> · ${esc(LEAD_SOURCES[lead.source] ?? lead.source)}\n${esc(lead.name)} · ${lead.phone}${lead.project ? `\n${esc(lead.project.name)}` : ""}${lead.notes ? `\n${esc(lead.notes.slice(0, 200))}` : ""}\nCall within 15 minutes.`;
    const owner = lead.ownerId ? await db.user.findUnique({ where: { id: lead.ownerId } }) : null;
    if (owner?.telegramChatId) await send(owner.telegramChatId, text);
    else await notifyRoles(["SALES_HEAD", "SALES_MANAGER"], text + "\n<i>Nobody is assigned yet. Please assign it in Vida OS.</i>", { projectId: lead.projectId });
  } catch {
    // An alert failing must never lose the lead.
  }
  // If the MD switched it on, the AI caller rings the buyer within a minute (9 am to 9 pm).
  await autoCallNewLead(leadId);
}
