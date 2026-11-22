import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { datetime, ago } from "@/lib/format";
import { PageHeader, Card, Stat, Button, Field, Notice, Table } from "@/components/ui";
import { account, bolnaConfigured, getConfig, syncOpenCalls, settingsOf, AUTO_CALL_SOURCES, LANGUAGES, talkedWhere } from "@/lib/bolna";
import { LEAD_SOURCES } from "@/lib/constants";
import { Flash, one, type SP } from "../_ui";
import { setupAgent, setAutoCall, testCall, callAnyNumber } from "./actions";
import { CALL_ROLES, SETTINGS_ROLES, CallTabs, callScope, TRIGGER, CallResult, Conversation, mins, masked, dollars } from "./_shared";

export const dynamic = "force-dynamic";

export default async function CallCentrePage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(CALL_ROLES);
  const sp = await searchParams;
  const isMd = u.role === "MD";
  const canSet = SETTINGS_ROLES.includes(u.role);
  const connected = bolnaConfigured();
  await syncOpenCalls();
  const scope = callScope(u);
  const since = new Date(Date.now() - 7 * 864e5);
  const [cfg, acct, calls, week, talked, interested, projects] = await Promise.all([
    getConfig(),
    connected && canSet ? account() : null,
    db.aiCall.findMany({ where: scope, orderBy: { createdAt: "desc" }, take: 10, include: { lead: { select: { id: true, name: true } } } }),
    db.aiCall.count({ where: { AND: [scope, { createdAt: { gt: since }, trigger: { not: "TEST" } }] } }),
    db.aiCall.findMany({ where: { AND: [scope, talkedWhere, { createdAt: { gt: since }, trigger: { not: "TEST" } }] }, select: { durationSec: true } }),
    db.aiCall.count({ where: { AND: [scope, { createdAt: { gt: since }, interest: "INTERESTED" }] } }),
    db.project.findMany({ where: projectScope(u).projectId ? { id: projectScope(u).projectId } : {}, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const avg = talked.length ? Math.round(talked.reduce((a, c) => a + (c.durationSec ?? 0), 0) / talked.length) : null;
  const ready = connected && !!cfg.agentId;
  const st = settingsOf(cfg);

  const steps = [
    { done: !!(connected && acct?.ok), label: "Bolna account connected", how: connected && acct && !acct.ok ? `Bolna refused the key: ${acct.error}` : "The MD signs up at bolna.ai, adds money, and puts the API key in Vercel as BOLNA_API_KEY." },
    { done: !!cfg.agentId, label: "AI caller set up", how: "Press “Set up AI caller” below." },
    { done: !!cfg.outcomesReady, label: "Call outcomes switched on", how: "Open AI caller settings and press Save once. Then each call is marked Interested, Not interested, Site visit and so on." },
    { done: cfg.autoCall, label: "Automatic calls to new leads", how: "Only after a good test call, and once Bolna is upgraded with an Indian calling number." },
  ];

  return (
    <>
      <PageHeader eyebrow="Sales" title="AI call centre" />
      <CallTabs active="/sales/calls" role={u.role} />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <p className="mb-6 max-w-3xl text-sm text-stone">
        {st.callerName}, our AI caller, rings buyers in {LANGUAGES[st.language]} and switches smoothly to English, Hindi or Telugu, whichever they prefer. She asks what they are looking for, and offers a site visit. The salesperson then gets the summary on Telegram and makes the real call. It only calls between 9 am and 9 pm, only people who asked to be contacted, and never quotes prices or dates.
      </p>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="AI calls, last 7 days" value={week} sub={`${talked.length} conversations`} />
        <Stat label="Interested buyers, 7 days" value={interested} tone={interested ? "good" : undefined} />
        <Stat label="Average conversation" value={mins(avg)} />
        {canSet ? (
          <Stat label="Bolna balance" value={acct?.ok && acct.wallet != null ? dollars(Number(acct.wallet)) : "–"} sub={acct?.ok ? "Top up on bolna.ai" : "Not connected"} tone={acct?.ok && (acct.wallet ?? 0) < 200 ? "bad" : undefined} />
        ) : (
          <Stat label="Automatic calls" value={cfg.autoCall ? "On" : "Off"} />
        )}
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <Card title="Call anyone with AI">
          {ready ? (
            <form action={callAnyNumber} className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Buyer's name"><input className="input" name="name" required placeholder="Ravi Kumar" /></Field>
                <Field label="Mobile number"><input className="input" name="phone" required inputMode="tel" placeholder="98xxxxxxxx" /></Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Project">
                  <select className="input" name="projectId" defaultValue={projects.length === 1 ? projects[0].id : ""}>
                    <option value="">Not sure yet</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label="Note (optional)"><input className="input" name="note" placeholder="Met at the expo" /></Field>
              </div>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consent" required className="mt-1 accent-[#a07a45]" /> This person asked to be contacted by Vida Estates.</label>
              <div><Button>📞 Call now with AI</Button></div>
              <p className="text-xs text-stone">The buyer is saved as a lead, and the result appears on the lead and in Call history. You can also send /lead to the Telegram bot.</p>
            </form>
          ) : (
            <p className="text-sm text-stone">Calling isn&apos;t ready yet. The MD finishes the setup on this page first.</p>
          )}
        </Card>

        <div className="grid content-start gap-6">
          {isMd && (
            <Card title="Setup">
              <ol className="grid gap-3 text-sm">
                {steps.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-6 shrink-0">{s.done ? "✅" : `${i + 1}.`}</span>
                    <div><p className="font-medium">{s.label}</p>{!s.done && <p className="text-stone">{s.how}</p>}</div>
                  </li>
                ))}
              </ol>
              <div className="mt-5 flex flex-wrap gap-3">
                {connected && !cfg.agentId && <form action={setupAgent}><Button size="sm">Set up AI caller</Button></form>}
                {cfg.agentId && (
                  <form action={setAutoCall}>
                    <input type="hidden" name="on" value={cfg.autoCall ? "0" : "1"} />
                    <Button variant={cfg.autoCall ? "secondary" : "primary"} size="sm">{cfg.autoCall ? "Switch off automatic calls" : "Switch on automatic calls"}</Button>
                  </form>
                )}
              </div>
              {cfg.agentId && <p className="mt-3 text-xs text-stone">Automatic calls go to: {AUTO_CALL_SOURCES.map((s) => LEAD_SOURCES[s] ?? s).join(", ")}. Walk-ins, referrals and channel-partner leads are never called automatically.</p>}
            </Card>
          )}
          {canSet && cfg.agentId && (
            <Card title="Test call to your phone">
              <form action={testCall} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field label="Your mobile number"><input className="input" name="phone" inputMode="tel" placeholder="98xxxxxxxx" required /></Field>
                <Button size="sm" variant="secondary">Call me</Button>
              </form>
              <p className="mt-2 text-xs text-stone">While Bolna is on a trial, it can only call numbers verified on bolna.ai.</p>
            </Card>
          )}
          {!connected && <Notice>Bolna isn&apos;t connected yet, so no calls can be made.</Notice>}
        </div>
      </div>

      <Card title="Latest calls" action={<Link href="/sales/calls/history" className="text-sm underline underline-offset-4">All calls</Link>} pad={false}>
        <Table head={["When", "Buyer", "Why", "Result", "Talked", "What was said"]} empty="No AI calls yet.">
          {calls.map((c) => (
            <tr key={c.id} className="align-top">
              <td className="whitespace-nowrap">{datetime(c.createdAt)}<p className="text-xs text-stone">{ago(c.createdAt)}</p></td>
              <td>{c.lead ? <Link className="underline underline-offset-4" href={`/sales/leads/${c.lead.id}`}>{c.lead.name}</Link> : <span className="text-stone">{masked(c.toNumber)}</span>}</td>
              <td>{TRIGGER[c.trigger] ?? c.trigger}</td>
              <td><CallResult status={c.status} interest={c.interest} visitNote={c.visitNote} />{c.error && <p className="mt-1 max-w-48 text-xs text-stone">{c.error}</p>}</td>
              <td className="whitespace-nowrap">{mins(c.durationSec)}</td>
              <td><Conversation summary={c.summary} transcript={c.transcript} recordingId={c.recordingUrl ? c.id : null} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
