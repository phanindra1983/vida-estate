import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { LEAD_SOURCES } from "@/lib/constants";
import { publicUrl } from "@/lib/notify";
import { PUSH_SOURCES, sourceKey, rotateSourceKey } from "@/lib/lead-intake";
import { ago } from "@/lib/format";
import { PageHeader, Card, Badge, Button, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
const ROLES = ["MD", "SALES_HEAD", "MARKETING"];

async function rotate(fd: FormData) {
  "use server";
  const u = await requireUser(["MD"]);
  const source = String(fd.get("source"));
  if (!PUSH_SOURCES.some((s) => s.source === source)) redirect("/control/leads");
  await rotateSourceKey(source);
  await audit(u, "UPDATE", "Setting", `leads.key.${source}`, `Made a new lead key for ${LEAD_SOURCES[source] ?? source}; the old address stops working`);
  revalidatePath("/control/leads");
  redirect("/control/leads?ok=" + encodeURIComponent(`New key made for ${LEAD_SOURCES[source] ?? source}. Give the platform the new address.`));
}

const HOWTO: Record<string, string[]> = {
  "99ACRES": ["Email or call your 99acres account manager and ask for “lead push / CRM integration to our own URL”.", "Give them the address below. Leads then arrive here the moment a buyer enquires."],
  MAGICBRICKS: ["Ask your MagicBricks relationship manager for “lead push API to client CRM”.", "Give them the address below."],
  HOUSING: ["Ask your Housing.com account manager to push leads to your CRM (webhook).", "Give them the address below."],
  NOBROKER: ["Ask your NoBroker account manager to push builder leads to your CRM URL.", "Give them the address below."],
  SQUAREYARDS: ["Ask your Square Yards account manager to push leads to your CRM URL.", "Give them the address below."],
  META: [
    "Quickest: connect your Meta lead forms with Zapier, Make or Pabbly (“Facebook Lead Ads → Webhook”), and post to the address below.",
    "Direct (no extra tool): in a Meta developer app, subscribe the Page to the “leadgen” webhook with the callback address below without “?key=…”, and the key as the verify token. Then add META_APP_SECRET and META_PAGE_TOKEN in Vercel.",
  ],
  GOOGLE: ["In Google Ads, open the lead form → Lead delivery → Webhook integration.", "Paste the webhook URL and the key below, then press “Send test data”. A test shows here as “test received”."],
  OTHER_PORTAL: ["For any other platform or tool that can send a webhook (JSON or form post)."],
};

export default async function LeadSources({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const me = await requireUser(ROLES);
  const sp = await searchParams;
  const since = new Date(Date.now() - 30 * 864e5);
  const counts = await db.lead.groupBy({ by: ["source"], where: { createdAt: { gte: since } }, _count: true });
  const lasts = new Map((await db.setting.findMany({ where: { key: { startsWith: "leads.last." } } })).map((s) => [s.key.slice(11), JSON.parse(s.value) as { at: string; test: boolean }]));
  const rows = await Promise.all(
    PUSH_SOURCES.map(async (s) => {
      const key = await sourceKey(s.source);
      const url = s.source === "GOOGLE" ? publicUrl("/api/leads/google") : s.source === "META" ? publicUrl(`/api/leads/meta?key=${key}`) : publicUrl(`/api/leads/in/${s.slug}?key=${key}`);
      return { ...s, key, url, count: counts.find((c) => c.source === s.source)?._count ?? 0, last: lasts.get(s.source) };
    }),
  );
  const web = { count: counts.find((c) => c.source === "WEBSITE")?._count ?? 0, last: lasts.get("WEBSITE") };

  return (
    <>
      <PageHeader eyebrow="Control" title="Lead sources" />
      {sp.ok && <div className="mb-6"><Notice tone="good">{sp.ok}</Notice></div>}
      <p className="mb-6 max-w-3xl text-sm text-stone">
        Every platform gets its own private address. Leads that arrive are checked for duplicates, given to the next salesperson for that project,
        and the salesperson gets a Telegram alert at once. Add <code>&amp;project=VA</code> (the project code) to an address when the platform cannot say which project the buyer asked about.
        Keep these addresses private: anyone with one can add leads.
      </p>
      <div className="grid gap-4">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">Website</p>
            <span className="text-sm text-stone">{web.count} leads in 30 days{web.last ? ` · last ${ago(web.last.at)}` : ""}</span>
          </div>
          <p className="mt-1 text-sm text-stone">Connected: the enquiry form on vidaestates.co.in.</p>
        </Card>
        {rows.map((r) => (
          <Card key={r.source}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{LEAD_SOURCES[r.source] ?? r.source}</p>
              <span className="flex items-center gap-2 text-sm text-stone">
                {r.count} leads in 30 days
                {r.last ? <Badge tone="good">{r.last.test ? "test received" : "last lead"} {ago(r.last.at)}</Badge> : <Badge>not connected yet</Badge>}
              </span>
            </div>
            <ul className="mt-2 list-disc pl-5 text-sm text-ink-2">{(HOWTO[r.source] ?? HOWTO.OTHER_PORTAL).map((h) => <li key={h}>{h}</li>)}</ul>
            <div className="mt-3 grid gap-2 text-xs">
              <label className="grid gap-1">
                <span className="text-stone">{r.source === "GOOGLE" ? "Webhook URL" : "Address to give them"}</span>
                <input className="input font-mono text-xs" readOnly value={r.url} />
              </label>
              {(r.source === "GOOGLE" || r.source === "META") && (
                <label className="grid gap-1">
                  <span className="text-stone">{r.source === "GOOGLE" ? "Key" : "Verify token (direct Meta webhook)"}</span>
                  <input className="input font-mono text-xs" readOnly value={r.key} />
                </label>
              )}
            </div>
            {me.role === "MD" && (
              <form action={rotate} className="mt-3">
                <input type="hidden" name="source" value={r.source} />
                <Button size="sm" variant="secondary">New key (old address stops working)</Button>
              </form>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
