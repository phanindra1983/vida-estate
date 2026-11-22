import Link from "next/link";
import { Badge, Button, Status } from "@/components/ui";
import { ago } from "@/lib/format";
import { LEAD_SOURCES, PURPOSES, TIMELINES } from "@/lib/constants";
import { TEMP, temperature } from "@/lib/lead-score";
import { INTEREST } from "@/lib/bolna";
import { bulkLeads } from "./crm-actions";
import { SelectAll } from "./_select";

export type CrmLead = {
  id: string; name: string; phone: string; stage: string; source: string; score: number; budget: string | null; preferredType: string | null;
  purpose: string | null; timeline: string | null; ownerId: string | null; qualifiedAt: Date | null; qualifiedById: string | null; nextFollowUp: Date | null;
  lastActivityAt: Date | null; createdAt: Date; consentAt: Date | null; doNotCallAt: Date | null; duplicateCount: number;
  project: { name: string } | null; lastAi?: { interest: string | null; status: string } | null;
};

export function Temp({ score }: { score: number }) {
  const t = TEMP[temperature(score)];
  return <Badge tone={t.tone}>{t.icon} {t.label} · {score}</Badge>;
}

export const telHref = (phone: string) => `tel:+91${phone.replace(/\D/g, "").slice(-10)}`;

/** One phone button: dials from the salesperson's phone (or Mac via iPhone). */
export function PhoneLink({ phone, label = "Call" }: { phone: string; label?: string }) {
  return (
    <a href={telHref(phone)} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-medium hover:border-stone" title={`Call ${phone}`}>
      📞 {label}
    </a>
  );
}

/**
 * The lead list used on Leads and Qualified leads: tick rows, then call them with AI now,
 * schedule AI calls for later, or (managers) assign them.
 */
export function LeadTable({
  leads, owners, isManager, back, listName, showQualified = false, userNames,
}: {
  leads: CrmLead[]; owners: { id: string; name: string }[]; isManager: boolean; back: string; listName: string; showQualified?: boolean; userNames: Map<string, string>;
}) {
  const formId = `bulk-${listName.replace(/\W+/g, "-").toLowerCase()}`;
  const tomorrow10 = (() => {
    const d = new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return `${d}T10:00`;
  })();
  return (
    <form id={formId} action={bulkLeads}>
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="listName" value={listName} />
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-[#fbfaf7] p-3">
        <SelectAll formId={formId} />
        <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <Button size="sm" name="op" value="ai_now">🤖 AI call now</Button>
        <span className="flex items-center gap-2">
          <input className="input min-h-9 py-1 text-xs" type="datetime-local" name="when" defaultValue={tomorrow10} aria-label="When to start the AI calls" />
          <Button size="sm" variant="secondary" name="op" value="ai_schedule">🗓 Schedule AI calls</Button>
        </span>
        {isManager && (
          <span className="flex items-center gap-2">
            <select className="input min-h-9 py-1 text-xs" name="ownerId" defaultValue="" aria-label="Assign to">
              <option value="">Assign to…</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <Button size="sm" variant="secondary" name="op" value="assign">Assign</Button>
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone">
            <tr className="border-b border-line">
              <th className="w-10 px-3 py-2.5" />
              <th className="px-3 py-2.5">Buyer</th>
              <th className="px-3 py-2.5">Score</th>
              <th className="px-3 py-2.5">Wants</th>
              <th className="px-3 py-2.5">Stage</th>
              <th className="px-3 py-2.5">{showQualified ? "Qualified" : "Source"}</th>
              <th className="px-3 py-2.5">Owner</th>
              <th className="px-3 py-2.5">Next step</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {leads.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-stone">No leads in this list.</td></tr>}
            {leads.map((l) => {
              const wants = [l.preferredType, l.budget, l.purpose && PURPOSES[l.purpose], l.timeline && TIMELINES[l.timeline]].filter(Boolean).join(" · ");
              const aiOk = !!l.consentAt && !l.doNotCallAt;
              return (
                <tr key={l.id} className="align-top hover:bg-[#fbfaf7]">
                  <td className="px-3 py-3"><input type="checkbox" name="ids" value={l.id} className="h-4 w-4 accent-[#a07a45]" aria-label={`Tick ${l.name}`} /></td>
                  <td className="px-3 py-3">
                    <Link href={`/sales/leads/${l.id}`} className="font-medium hover:underline">{l.name}</Link>
                    <div className="text-xs text-stone">{l.phone}{l.project ? ` · ${l.project.name}` : ""}{l.duplicateCount > 0 ? ` · enquired ${l.duplicateCount + 1}×` : ""}</div>
                    {!aiOk && <div className="text-xs text-stone" title={l.doNotCallAt ? "Asked not to be called" : "No consent recorded, so the AI caller won't call. You can still call."}>{l.doNotCallAt ? "🚫 Asked not to be called" : "AI can't call (no consent)"}</div>}
                  </td>
                  <td className="px-3 py-3"><Temp score={l.score} /></td>
                  <td className="px-3 py-3 text-xs">{wants || <span className="text-stone">–</span>}</td>
                  <td className="px-3 py-3">
                    <Status value={l.stage} />
                    {l.lastAi?.interest && INTEREST[l.lastAi.interest] && <div className="mt-1"><Badge tone={INTEREST[l.lastAi.interest].tone}>AI: {INTEREST[l.lastAi.interest].label}</Badge></div>}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {showQualified
                      ? <>{l.qualifiedAt ? ago(l.qualifiedAt) : "–"}<div className="text-stone">by {l.qualifiedById ? userNames.get(l.qualifiedById) ?? "staff" : "AI caller"}</div></>
                      : LEAD_SOURCES[l.source] ?? l.source}
                  </td>
                  <td className="px-3 py-3 text-xs">{l.ownerId ? userNames.get(l.ownerId) ?? "–" : <Badge tone="warn">Unassigned</Badge>}</td>
                  <td className="px-3 py-3 text-xs text-stone">
                    {l.nextFollowUp
                      ? l.nextFollowUp.getTime() < Date.now()
                        ? <span className="text-bad">Follow-up {ago(l.nextFollowUp).replace(" ago", "")} overdue</span>
                        : <span>Follow up {l.nextFollowUp.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
                      : l.lastActivityAt ? `Last touch ${ago(l.lastActivityAt)}` : `New ${ago(l.createdAt)}`}
                  </td>
                  <td className="px-3 py-3"><PhoneLink phone={l.phone} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </form>
  );
}
