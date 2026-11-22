import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { datetime, ago } from "@/lib/format";
import { PageHeader, Card, Stat, Badge, Button, Field, Notice, Table } from "@/components/ui";
import { account, bolnaConfigured, getConfig, syncOpenCalls, FINAL, STATUS_LABEL, AUTO_CALL_SOURCES } from "@/lib/bolna";
import { LEAD_SOURCES } from "@/lib/constants";
import { Flash, one, type SP } from "../_ui";
import { setupAgent, setAutoCall, testCall } from "./actions";

export const dynamic = "force-dynamic";
const ROLES = ["MD", "SALES_HEAD", "SALES_MANAGER", "MARKETING"];
const TRIGGER: Record<string, string> = { AUTO: "New lead", MANUAL: "Asked by staff", TEST: "Test" };

const tone = (s: string) => (s === "completed" ? "good" : FINAL.includes(s) || s === "FAILED_TO_START" ? "bad" : "warn") as "good" | "bad" | "warn";
const mins = (sec: number | null) => (sec == null ? "–" : sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
const masked = (n: string) => n.slice(0, -4).replace(/\d/g, "•") + n.slice(-4);

export default async function CallCentrePage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(ROLES);
  const sp = await searchParams;
  const isMd = u.role === "MD";
  const connected = bolnaConfigured();
  await syncOpenCalls();
  const [cfg, acct, calls, week] = await Promise.all([
    getConfig(),
    connected ? account() : null,
    db.aiCall.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { lead: { select: { id: true, name: true } } } }),
    db.aiCall.findMany({ where: { createdAt: { gt: new Date(Date.now() - 7 * 864e5) }, trigger: { not: "TEST" } }, select: { status: true, durationSec: true } }),
  ]);
  const talked = week.filter((c) => c.status === "completed" && (c.durationSec ?? 0) > 0);
  const avg = talked.length ? Math.round(talked.reduce((a, c) => a + (c.durationSec ?? 0), 0) / talked.length) : null;

  const steps = [
    {
      done: !!(connected && acct?.ok),
      label: "Bolna account connected",
      how: connected && acct && !acct.ok ? `Bolna refused the key: ${acct.error}` : "The MD signs up at bolna.ai, adds money to the Bolna wallet, and puts the API key in Vercel as BOLNA_API_KEY.",
    },
    { done: !!cfg.agentId, label: "AI caller set up", how: "Press “Set up AI caller” below. It creates the calling script on Bolna." },
    { done: calls.some((c) => c.trigger === "TEST" && c.status === "completed"), label: "Test call answered", how: "Call your own number below and listen to how it sounds." },
    { done: cfg.autoCall, label: "Automatic calls to new leads switched on", how: "Only after a good test call." },
  ];

  return (
    <>
      <PageHeader eyebrow="Sales" title="AI call centre" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <p className="mb-6 max-w-3xl text-sm text-stone">
        An AI caller rings each new enquiry within a minute, asks what they are looking for, and offers a site visit. The salesperson then gets the summary on Telegram and makes the real call. It only calls between 9 am and 9 pm, only buyers who enquired themselves, and never quotes prices or dates.
      </p>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Automatic calls" value={cfg.autoCall ? "On" : "Off"} tone={cfg.autoCall ? "good" : "warn"} />
        <Stat label="AI calls, last 7 days" value={week.length} sub={`${talked.length} conversations`} />
        <Stat label="Average conversation" value={mins(avg)} />
        <Stat
          label="Bolna balance"
          value={acct?.ok && acct.wallet != null ? `$${Number(acct.wallet).toFixed(2)}` : "–"}
          sub={acct?.ok ? "Top up on bolna.ai" : "Not connected"}
          tone={acct?.ok && (acct.wallet ?? 0) < 5 ? "bad" : undefined}
        />
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <Card title="Setup">
          <ol className="grid gap-3 text-sm">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-6 shrink-0">{s.done ? "✅" : `${i + 1}.`}</span>
                <div>
                  <p className="font-medium">{s.label}</p>
                  {!s.done && <p className="text-stone">{s.how}</p>}
                </div>
              </li>
            ))}
          </ol>
          {isMd && connected && (
            <form action={setupAgent} className="mt-5">
              <Button variant={cfg.agentId ? "secondary" : "primary"} size="sm">{cfg.agentId ? "Re-create AI caller" : "Set up AI caller"}</Button>
              {cfg.agentId && <p className="mt-2 text-xs text-stone">Voice and language can be fine-tuned on bolna.ai.</p>}
            </form>
          )}
        </Card>

        <div className="grid content-start gap-6">
          {isMd && (
            <Card title="Automatic calls to new leads">
              <p className="mb-3 text-sm text-stone">
                Sources called: {AUTO_CALL_SOURCES.map((s) => LEAD_SOURCES[s] ?? s).join(", ")}. Walk-ins, referrals and channel-partner leads are never called by the AI.
              </p>
              {cfg.agentId || cfg.autoCall ? (
                <form action={setAutoCall}>
                  <input type="hidden" name="on" value={cfg.autoCall ? "0" : "1"} />
                  <Button variant={cfg.autoCall ? "secondary" : "primary"} size="sm">{cfg.autoCall ? "Switch off" : "Switch on"}</Button>
                </form>
              ) : (
                <p className="text-sm text-stone">Set up the AI caller first.</p>
              )}
            </Card>
          )}
          {(isMd || u.role === "SALES_HEAD") && cfg.agentId && (
            <Card title="Test call">
              <form action={testCall} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field label="Your mobile number"><input className="input" name="phone" inputMode="tel" placeholder="98xxxxxxxx" required /></Field>
                <Button size="sm">Call me</Button>
              </form>
            </Card>
          )}
          {!connected && <Notice>Bolna isn&apos;t connected yet, so no calls can be made.</Notice>}
        </div>
      </div>

      <Card title="Recent AI calls" pad={false}>
        <Table head={["When", "Buyer", "Why", "Result", "Talked", "What was said"]} empty="No AI calls yet.">
          {calls.map((c) => (
            <tr key={c.id} className="align-top">
              <td className="whitespace-nowrap">{datetime(c.createdAt)}<p className="text-xs text-stone">{ago(c.createdAt)}</p></td>
              <td>{c.lead ? <Link className="underline underline-offset-4" href={`/sales/leads/${c.lead.id}`}>{c.lead.name}</Link> : <span className="text-stone">{masked(c.toNumber)}</span>}</td>
              <td>{TRIGGER[c.trigger] ?? c.trigger}</td>
              <td>
                <Badge tone={tone(c.status)}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
                {c.error && <p className="mt-1 max-w-48 text-xs text-stone">{c.error}</p>}
              </td>
              <td className="whitespace-nowrap">{mins(c.durationSec)}</td>
              <td className="max-w-md text-sm">
                {c.summary ?? (!c.transcript && <span className="text-stone">–</span>)}
                {c.transcript && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-stone">Full conversation</summary>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-xs">{c.transcript}</pre>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
