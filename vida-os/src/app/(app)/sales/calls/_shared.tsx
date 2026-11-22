import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { cx, Badge } from "@/components/ui";
import type { CurrentUser } from "@/lib/auth";
import { FINAL, INTEREST, STATUS_LABEL } from "@/lib/bolna";

/** Everyone in sales uses the call centre; executives see only their own buyers' calls. */
export const CALL_ROLES = ["MD", "SALES_HEAD", "SALES_MANAGER", "SALES_EXEC", "MARKETING"];
export const CALL_MANAGERS = ["MD", "SALES_HEAD", "SALES_MANAGER"];
export const SETTINGS_ROLES = ["MD", "SALES_HEAD"];

export const TRIGGER: Record<string, string> = { AUTO: "New lead", MANUAL: "Asked by staff", CAMPAIGN: "Campaign", TEST: "Test" };

/** Which calls this person may see. */
export function callScope(u: CurrentUser): Prisma.AiCallWhereInput {
  if (u.role === "SALES_EXEC") return { OR: [{ startedById: u.id }, { lead: { ownerId: u.id } }] };
  if (u.projectIds === "ALL") return {};
  return { OR: [{ projectId: { in: u.projectIds } }, { projectId: null }] };
}

export function CallTabs({ active, role }: { active: string; role: string }) {
  const tabs: [string, string, boolean][] = [
    ["/sales/calls", "Overview", true],
    ["/sales/calls/history", "Call history", true],
    ["/sales/calls/campaigns", "Campaigns", CALL_MANAGERS.includes(role)],
    ["/sales/calls/reports", "Reports", CALL_MANAGERS.includes(role) || role === "MARKETING"],
    ["/sales/calls/settings", "AI caller settings", SETTINGS_ROLES.includes(role)],
  ];
  return (
    <nav className="-mt-4 mb-8 flex gap-1 overflow-x-auto border-b border-line text-sm">
      {tabs.filter((t) => t[2]).map(([href, label]) => (
        <Link key={href} href={href} className={cx("whitespace-nowrap border-b-2 px-3 py-2.5", active === href ? "border-ink text-ink" : "border-transparent text-stone hover:text-ink")}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export const statusTone = (s: string) => (s === "completed" ? "good" : FINAL.includes(s) ? "bad" : "warn") as "good" | "bad" | "warn";
export const mins = (sec: number | null | undefined) => (sec == null ? "–" : sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
export const masked = (n: string) => n.slice(0, -4).replace(/\d/g, "•") + n.slice(-4);
export const dollars = (cents: number | null | undefined) => (cents == null ? "–" : `$${(cents / 100).toFixed(2)}`);

export function CallResult({ status, interest, visitNote }: { status: string; interest: string | null; visitNote?: string | null }) {
  return (
    <div className="grid justify-items-start gap-1">
      <Badge tone={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Badge>
      {interest && INTEREST[interest] && <Badge tone={INTEREST[interest].tone}>{INTEREST[interest].label}</Badge>}
      {visitNote && <span className="text-xs">📅 Visit: {visitNote}</span>}
    </div>
  );
}

export function Conversation({ summary, transcript, recordingId }: { summary: string | null; transcript: string | null; recordingId?: string | null }) {
  return (
    <div className="max-w-md text-sm">
      {summary ?? (!transcript && <span className="text-stone">–</span>)}
      {recordingId && <audio className="mt-2 h-8 w-full max-w-xs" controls preload="none" src={`/api/bolna/recording/${recordingId}`} />}
      {transcript && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-stone">Full conversation</summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs">{transcript}</pre>
        </details>
      )}
    </div>
  );
}
