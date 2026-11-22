import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { datetime } from "@/lib/format";
import { PageHeader, Card, Button, Field, Table, Badge, Progress, Notice } from "@/components/ui";
import { getConfig, bolnaConfigured, syncOpenCalls, FINAL, talkedWhere } from "@/lib/bolna";
import { LEAD_SOURCES, LEAD_STAGES } from "@/lib/constants";
import { Flash, one, type SP } from "../../_ui";
import { CALL_MANAGERS, CallTabs } from "../_shared";
import { startCampaign, stopCampaign } from "../actions";
import { readAudience, audienceWhere, MAX_CAMPAIGN } from "../_audience";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // starting a campaign places up to 200 calls

const CALLABLE_STAGES = LEAD_STAGES.filter((s) => !["LOST", "BOOKED", "AGREEMENT_SIGNED"].includes(s.key));

export default async function CampaignsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(CALL_MANAGERS);
  const sp = await searchParams;
  await syncOpenCalls(15);
  const counted = one(sp.count) === "1";
  const a = readAudience((k) => sp[k] as string | string[] | undefined);
  const scope = projectScope(u);
  const [cfg, projects, campaigns, matching] = await Promise.all([
    getConfig(),
    db.project.findMany({ where: scope.projectId ? { id: scope.projectId } : {}, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.aiCampaign.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
    counted ? db.lead.count({ where: audienceWhere(a, u) }) : Promise.resolve(null),
  ]);
  const stats = await Promise.all(
    campaigns.map(async (c) => {
      const [done, talked, interested, visits] = await Promise.all([
        db.aiCall.count({ where: { campaignId: c.id, status: { in: FINAL } } }),
        db.aiCall.count({ where: { campaignId: c.id, ...talkedWhere } }),
        db.aiCall.count({ where: { campaignId: c.id, interest: "INTERESTED" } }),
        db.aiCall.count({ where: { campaignId: c.id, visitNote: { not: null } } }),
      ]);
      return { done, talked, interested, visits };
    }),
  );
  const ready = bolnaConfigured() && !!cfg.agentId;
  const sel = (k: string, v: string) => (Array.isArray(sp[k]) ? (sp[k] as string[]).includes(v) : sp[k] === v);

  return (
    <>
      <PageHeader eyebrow="Sales · AI call centre" title="Campaigns" />
      <CallTabs active="/sales/calls/campaigns" role={u.role} />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <p className="mb-6 max-w-3xl text-sm text-stone">
        A campaign lets the AI caller ring a whole group, about 2 calls a minute, only between 9 am and 9 pm. It only calls buyers who agreed to be contacted, and skips anyone who asked not to be called, was lost, or has booked. Up to {MAX_CAMPAIGN} buyers per campaign.
      </p>
      {!ready && <div className="mb-6"><Notice>The AI caller isn&apos;t set up yet. The MD finishes the setup on the Overview tab.</Notice></div>}

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <Card title="Call a group of leads">
          <form className="grid gap-4">
            <Field label="Campaign name"><input className="input" name="name" defaultValue={one(sp.name) ?? ""} placeholder="Aurum follow-ups, November" /></Field>
            <Field label="Project">
              <select className="input" name="projectId" defaultValue={a.projectId}>
                <option value="">All my projects</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-stone">Lead stage</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {CALLABLE_STAGES.map((s) => (
                  <label key={s.key} className="flex min-h-9 items-center gap-2"><input type="checkbox" name="stage" value={s.key} defaultChecked={counted ? sel("stage", s.key) : ["NEW", "CONTACTED"].includes(s.key)} className="accent-[#a07a45]" /> {s.label}</label>
                ))}
              </div>
            </fieldset>
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-stone">Came from (leave empty for any)</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {Object.entries(LEAD_SOURCES).map(([k, v]) => (
                  <label key={k} className="flex min-h-9 items-center gap-2"><input type="checkbox" name="source" value={k} defaultChecked={sel("source", k)} className="accent-[#a07a45]" /> {v}</label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="No activity for at least">
                <select className="input" name="idleDays" defaultValue={String(a.idleDays)}>
                  <option value="0">Any time</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="60">60 days</option>
                </select>
              </Field>
              <Field label="Call at most">
                <select className="input" name="limit" defaultValue={String(a.limit)}>
                  {[10, 25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} buyers</option>)}
                </select>
              </Field>
            </div>
            <input type="hidden" name="count" value="1" />
            {matching !== null && (
              <p className="rounded-lg bg-[#f6f4f0] px-3 py-2 text-sm">
                <b>{matching}</b> buyer{matching === 1 ? "" : "s"} match. {matching > a.limit ? `The newest ${a.limit} will be called.` : matching ? "All of them will be called." : "Try other choices."}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" type="submit">Count matching buyers</Button>
              {ready && matching ? <Button formAction={startCampaign} formMethod="post">📞 Start calling {Math.min(matching, a.limit)}</Button> : null}
            </div>
          </form>
        </Card>

        <Card title="Or paste a list">
          <form action={startCampaign} className="grid gap-4">
            <input type="hidden" name="mode" value="list" />
            <Field label="Campaign name"><input className="input" name="name" placeholder="Expo visitors, 22 Nov" /></Field>
            <Field label="Project">
              <select className="input" name="projectId" defaultValue={projects.length === 1 ? projects[0].id : ""}>
                <option value="">Not sure yet</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="One buyer per line: name and mobile number" hint="Copy two columns from Excel, or type them. Up to 200 lines.">
              <textarea className="input min-h-40 font-mono text-xs" name="list" required placeholder={"Ravi Kumar, 9876543210\nSita Reddy 9123456780"} />
            </Field>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consent" required className="mt-1 accent-[#a07a45]" /> Everyone on this list asked to be contacted by Vida Estates.</label>
            <div><Button disabled={!ready}>📞 Save and start calling</Button></div>
            <p className="text-xs text-stone">Each person is saved as a lead (source “Added by staff”), so results land in the CRM.</p>
          </form>
        </Card>
      </div>

      <Card title="Campaigns" pad={false}>
        <Table head={["Started", "Campaign", "Who", "Progress", "Talked", "Interested", "Visits", ""]} empty="No campaigns yet.">
          {campaigns.map((c, i) => {
            const s = stats[i];
            return (
              <tr key={c.id} className="align-top">
                <td className="whitespace-nowrap">{datetime(c.createdAt)}</td>
                <td><p className="font-medium">{c.name}</p><Badge tone={c.status === "RUNNING" ? "warn" : c.status === "DONE" ? "good" : "neutral"}>{c.status === "RUNNING" ? "Running" : c.status === "DONE" ? "Done" : "Stopped"}</Badge></td>
                <td className="max-w-56 text-xs text-stone">{c.audience}</td>
                <td className="min-w-32"><p className="mb-1 text-xs">{s.done} of {c.total} calls</p><Progress value={c.total ? (s.done / c.total) * 100 : 0} /></td>
                <td>{s.talked}</td>
                <td>{s.interested}</td>
                <td>{s.visits}</td>
                <td>
                  <a className="text-sm underline underline-offset-4" href={`/sales/calls/history?days=0&trigger=CAMPAIGN`}>Calls</a>
                  {c.status === "RUNNING" && (
                    <form action={stopCampaign} className="mt-2">
                      <input type="hidden" name="id" value={c.id} />
                      <Button size="sm" variant="danger">Stop</Button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <p className="mt-3 text-xs text-stone">Stop cancels every AI call still waiting to start, including any from other campaigns.</p>
    </>
  );
}
