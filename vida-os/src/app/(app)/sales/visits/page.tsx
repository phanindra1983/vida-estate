import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { istDayStart } from "@/lib/format";
import { SALES_ROLES } from "@/lib/constants";
import { waLink } from "@/lib/notify";
import { visitsBetween, reminderText, mapLink, type Visit } from "@/lib/visits";
import { PageHeader, Card, Stat, Button } from "@/components/ui";
import { Flash, SubNav, one, type SP } from "../_ui";
import { PhoneLink } from "../_crm";
import { userNames } from "../_crm-data";
import { markVisitAction } from "../crm-actions";

export const dynamic = "force-dynamic";

const timeIST = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const dayIST = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });

function VisitRow({ v, names, kind, back, showDay }: { v: Visit; names: Map<string, string>; kind: "tomorrow" | "today" | "check" | "later"; back: string; showDay?: boolean }) {
  const owner = v.lead.ownerId ? names.get(v.lead.ownerId) ?? null : null;
  const wa = waLink(v.lead.phone, reminderText(v, kind === "today" || kind === "check" ? "today" : "tomorrow", owner));
  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3.5 text-sm">
      <div className="w-24 shrink-0">
        <p className="font-medium">{timeIST(v.at)}</p>
        {showDay && <p className="text-xs text-stone">{dayIST(v.at)}</p>}
      </div>
      <div className="min-w-48 flex-1">
        <Link href={`/sales/leads/${v.leadId}`} className="font-medium hover:underline">{v.lead.name}</Link>
        <p className="text-xs text-stone">{v.lead.phone} · {v.lead.project?.name ?? "–"} · {owner ?? "Unassigned"}</p>
        {v.note && v.note !== "Site visit scheduled" && <p className="text-xs">{v.note}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PhoneLink phone={v.lead.phone} />
        {kind !== "check" && <a href={wa} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center rounded-lg border border-line bg-white px-2.5 text-xs font-medium hover:border-stone">💬 {kind === "today" ? "See you today" : "Send reminder"}</a>}
        <a href={mapLink(v.lead.project)} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center rounded-lg border border-line bg-white px-2.5 text-xs hover:border-stone">📍 Map</a>
        {(kind === "today" || kind === "check") && (
          <form action={markVisitAction} className="flex gap-2">
            <input type="hidden" name="leadId" value={v.leadId} />
            <input type="hidden" name="back" value={back} />
            <Button size="sm" name="came" value="1">✅ Came</Button>
            <Button size="sm" variant="secondary" name="came" value="0">❌ Didn&apos;t come</Button>
          </form>
        )}
      </div>
    </li>
  );
}

function Section({ title, hint, visits, names, kind, showDay }: { title: string; hint: string; visits: Visit[]; names: Map<string, string>; kind: "tomorrow" | "today" | "check" | "later"; showDay?: boolean }) {
  return (
    <Card title={`${title} (${visits.length})`} pad={false}>
      <p className="border-b border-line px-5 py-2 text-xs text-stone">{hint}</p>
      <ul className="divide-y divide-line">
        {visits.length === 0 && <li className="px-5 py-4 text-sm text-stone">None.</li>}
        {visits.map((v) => <VisitRow key={v.leadId + v.at.toISOString()} v={v} names={names} kind={kind} back="/sales/visits" showDay={showDay} />)}
      </ul>
    </Card>
  );
}

export default async function SiteVisitsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(SALES_ROLES);
  const sp = await searchParams;
  const scope = u.role === "SALES_EXEC" ? { ownerId: u.id } : u.projectIds === "ALL" ? {} : { projectIds: u.projectIds };
  const now = new Date();
  const [today, tomorrow, week, overdue, names, quiet] = await Promise.all([
    visitsBetween(istDayStart(0), istDayStart(1), scope),
    visitsBetween(istDayStart(1), istDayStart(2), scope),
    visitsBetween(istDayStart(2), istDayStart(8), scope),
    visitsBetween(new Date(Date.now() - 30 * 864e5), istDayStart(0), scope),
    userNames(),
    db.lead.count({ where: { stage: "VISIT_DONE", lastActivityAt: { lt: new Date(Date.now() - 10 * 864e5) }, ...(u.role === "SALES_EXEC" ? { ownerId: u.id } : u.projectIds === "ALL" ? {} : { projectId: { in: u.projectIds } }) } }),
  ]);
  const todayPast = today.filter((v) => v.at < now);
  const todayNext = today.filter((v) => v.at >= now);
  const check = [...overdue, ...todayPast];

  return (
    <>
      <PageHeader eyebrow="Sales" title="Site visits" />
      <SubNav active="/sales/visits" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <p className="mb-6 max-w-3xl text-sm text-stone">
        Reminders go out by themselves: at 7 pm the evening before, the salesperson gets each visit on Telegram with a one-tap WhatsApp reminder for the buyer (and the buyer gets an email if we have it). At 8 am on the day, a “see you today” message. At 7 pm, “Did they come?” with ✅ / ❌ buttons. Buyers who visited and went quiet for 10 days come up to be invited back.
      </p>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Visits today" value={today.length} />
        <Stat label="Tomorrow" value={tomorrow.length} />
        <Stat label="Did they come? (to mark)" value={check.length} tone={check.length ? "warn" : "good"} />
        <Stat label="Visited, gone quiet" value={quiet} tone={quiet ? "warn" : undefined} sub={<Link className="underline underline-offset-4" href="/sales/leads?view=revisit">Invite them back</Link>} />
      </div>

      <div className="grid gap-6">
        {check.length > 0 && <Section title="Did they come?" hint="Visit time has passed. Mark each one so the follow-up is right." visits={check} names={names} kind="check" showDay />}
        <Section title="Today" hint="Send “see you today” in the morning; mark after the visit." visits={todayNext} names={names} kind="today" />
        <Section title="Tomorrow" hint="Send the reminder this evening." visits={tomorrow} names={names} kind="tomorrow" />
        <Section title="Next 7 days" hint="Coming up." visits={week} names={names} kind="later" showDay />
      </div>
    </>
  );
}
